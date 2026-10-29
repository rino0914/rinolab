#!/usr/bin/env bash

set -Eeuo pipefail
umask 027

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

API_STAGE=""
PORTAL_STAGE=""
ENV_STAGE=""
ACTIVATION_STARTED=0
ENV_CHANGED=0
ENV_WAS_PRESENT=0
UNIT_CHANGED=0
UNIT_WAS_PRESENT=0
API_CHANGED=0
API_WAS_PRESENT=0
PORTAL_CHANGED=0
PORTAL_WAS_PRESENT=0
CADDY_CHANGED=0
SERVICE_ENABLE_CHANGED=0
SERVICE_START_ATTEMPTED=0
SERVICE_WAS_ACTIVE=0
SERVICE_WAS_ENABLED=""
readonly DEPLOY_ID="$(date -u +%Y%m%dT%H%M%SZ).$$"

read_env_value() {
    local file="$1"
    local name="$2"

    awk -v name="$name" '
        index($0, name "=") == 1 {
            print substr($0, length(name) + 2)
            exit
        }
    ' "$file"
}

prepare_environment() {
    local missing_secrets=""
    local secret_name
    local secret_value

    for secret_name in \
        MONGODB_URI \
        SESSION_SECRET \
        OIDC_COOKIE_KEYS \
        OIDC_CLIENT_SECRET; do
        secret_value="$(read_env_value "$SOURCE_ENV" "$secret_name")"
        [ -z "$secret_value" ] ||
            fail "Secret must stay empty in Git-managed config: $secret_name"
    done

    ENV_STAGE="$(mktemp)"

    if sudo test -f "$ENV_FILE"; then
        sudo awk '
            BEGIN {
                secret["MONGODB_URI"] = 1
                secret["SESSION_SECRET"] = 1
                secret["OIDC_COOKIE_KEYS"] = 1
                secret["OIDC_CLIENT_SECRET"] = 1
            }
            FNR == NR {
                separator = index($0, "=")
                if (separator > 1) {
                    name = substr($0, 1, separator - 1)
                    if (secret[name]) {
                        current[name] = substr($0, separator + 1)
                    }
                }
                next
            }
            {
                separator = index($0, "=")
                if (separator > 1) {
                    name = substr($0, 1, separator - 1)
                    value = substr($0, separator + 1)
                    if (secret[name] && value == "" && current[name] != "") {
                        print name "=" current[name]
                        next
                    }
                }
                print
            }
        ' "$ENV_FILE" "$SOURCE_ENV" > "$ENV_STAGE"
    else
        cp "$SOURCE_ENV" "$ENV_STAGE"
        sudo install -o root -g "$DEPLOY_USER" -m 0640 \
            "$ENV_STAGE" "$ENV_FILE"
    fi

    local clients_file
    clients_file="$(read_env_value "$ENV_STAGE" "OIDC_CLIENTS_FILE")"

    for secret_name in \
        MONGODB_URI \
        SESSION_SECRET \
        OIDC_COOKIE_KEYS \
        OIDC_CLIENT_SECRET; do
        secret_value="$(read_env_value "$ENV_STAGE" "$secret_name")"
        if [ "$secret_name" = "OIDC_CLIENT_SECRET" ] && [ -n "$clients_file" ]; then
            continue
        fi
        if [ -z "$secret_value" ] || [[ "$secret_value" == *CHANGE_ME* ]]; then
            missing_secrets="${missing_secrets}${missing_secrets:+, }${secret_name}"
        fi
    done

    [ -z "$missing_secrets" ] ||
        fail "Set these values in $ENV_FILE, then run deployment again: $missing_secrets"
}

validate_oidc_client_registry() {
    local clients_file
    clients_file="$(read_env_value "$ENV_STAGE" "OIDC_CLIENTS_FILE")"
    [ -n "$clients_file" ] || return 0

    [ "$clients_file" = "$OIDC_CLIENTS_FILE_DEFAULT" ] ||
        log_warning "OIDC client registry uses non-default path: $clients_file"
    sudo test -f "$clients_file" || fail "OIDC client registry not found: $clients_file"
    sudo -u "$DEPLOY_USER" test -r "$clients_file" ||
        fail "$DEPLOY_USER cannot read $clients_file"
    [ "$(sudo stat -c '%U:%G:%a' "$clients_file")" = "root:$DEPLOY_USER:640" ] ||
        fail "$clients_file must be owned by root:$DEPLOY_USER with mode 0640"
    sudo -u "$DEPLOY_USER" "$NODE_BIN" \
        "$SOURCE_API/scripts/validate-oidc-clients.js" "$clients_file" ||
        fail "Invalid OIDC client registry: $clients_file"
}

cleanup() {
    if [ -n "${API_STAGE:-}" ] && [ -d "$API_STAGE" ]; then
        rm -rf -- "$API_STAGE"
    fi
    if [ -n "${PORTAL_STAGE:-}" ] && sudo test -d "$PORTAL_STAGE"; then
        sudo rm -rf -- "$PORTAL_STAGE"
    fi
    if [ -n "${ENV_STAGE:-}" ] && [ -f "$ENV_STAGE" ]; then
        rm -f -- "$ENV_STAGE"
    fi
}

# EXIT also handles explicit fail() calls and INT/TERM; ERR alone misses these.
finish_deployment() {
    local status="$?"
    trap - EXIT ERR
    trap '' INT TERM
    set +e

    if [ "$status" -ne 0 ] && [ "$ACTIVATION_STARTED" = "1" ]; then
        rollback_deployment
    fi
    cleanup
    exit "$status"
}

preserve_legacy_environment() {
    if [ -f "$SOURCE_ENV" ] && ! sudo test -f "$ENV_FILE"; then
        log "Preserving the existing production environment before checkout"
        sudo install -d -o root -g "$DEPLOY_USER" -m 0750 /etc/rinolab
        sudo install -o root -g "$DEPLOY_USER" -m 0640 \
            "$SOURCE_ENV" "$ENV_FILE"
    fi
}

checkout_source() {
    if ! git -C "$REPO_DIR" rev-parse --is-inside-work-tree > /dev/null 2>&1; then
        log "Repository not found; cloning $REPO_URL"
        mkdir -p "$(dirname "$REPO_DIR")"
        git clone --branch "$DEPLOY_BRANCH" --single-branch \
            "$REPO_URL" "$REPO_DIR"
    fi

    if [ -n "$(git -C "$REPO_DIR" status --porcelain)" ]; then
        git -C "$REPO_DIR" status --short
        fail "Repository has local changes; refusing to overwrite them"
    fi

    git -C "$REPO_DIR" remote set-url origin "$REPO_URL"
    git -C "$REPO_DIR" fetch --prune origin "$DEPLOY_BRANCH"
    git -C "$REPO_DIR" checkout --detach FETCH_HEAD
    log "Deploying commit: $(git -C "$REPO_DIR" rev-parse --short HEAD)"
}

run_preflight() {
    require_commands \
        awk bash caddy cp curl find flock getent git install mktemp npm rsync \
        stat sudo systemctl

    [ -x "$NODE_BIN" ] || fail "Node.js executable not found: $NODE_BIN"

    if ! "$NODE_BIN" -e '
        const [major, minor] = process.versions.node.split(".").map(Number);
        process.exit((major === 22 && minor >= 1) || major === 24 ? 0 : 1);
    '; then
        fail "Unsupported Node.js version: $($NODE_BIN --version 2> /dev/null || echo not-installed); use Node.js 22.1+ or 24.x LTS"
    fi

    [ -r "$SOURCE_API/package-lock.json" ] ||
        fail "API source is incomplete: $SOURCE_API"
    [ -d "$SOURCE_PORTAL" ] || fail "Portal source not found: $SOURCE_PORTAL"
    [ -r "$SOURCE_CADDY" ] || fail "Caddy source config not found: $SOURCE_CADDY"
    [ -r "$SOURCE_SERVICE" ] ||
        fail "systemd source unit not found: $SOURCE_SERVICE"
    [ -r "$SOURCE_ENV" ] ||
        fail "Production environment config not found: $SOURCE_ENV"
    [ -r "$HEALTH_CHECK_SCRIPT" ] ||
        fail "Health check script not found: $HEALTH_CHECK_SCRIPT"
    [ -r "$ROLLBACK_SCRIPT" ] || fail "Rollback script not found: $ROLLBACK_SCRIPT"

    sudo -v
    getent group "$CADDY_GROUP" > /dev/null ||
        fail "Required group not found: $CADDY_GROUP"

    sudo install -d -o root -g "$DEPLOY_USER" -m 0750 /etc/rinolab

    prepare_environment
    prepare_jwks
    validate_oidc_client_registry

    sudo caddy validate --config "$SOURCE_CADDY"

    if command -v systemd-analyze > /dev/null 2>&1; then
        sudo systemd-analyze verify "$SOURCE_SERVICE"
    fi
}

prepare_jwks() {
    if ! sudo test -f "$JWKS_FILE"; then
        if sudo test -f "$LEGACY_JWKS_FILE"; then
            log "Migrating legacy OIDC JWKS"
            sudo install -o root -g "$DEPLOY_USER" -m 0640 \
                "$LEGACY_JWKS_FILE" "$JWKS_FILE"
        else
            log "Generating persistent OIDC JWKS"
            sudo "$NODE_BIN" "$SOURCE_API/scripts/generate-oidc-key.js" "$JWKS_FILE"
        fi
    fi

    sudo chown root:"$DEPLOY_USER" "$JWKS_FILE"
    sudo chmod 0640 "$JWKS_FILE"

    sudo -u "$DEPLOY_USER" test -r "$JWKS_FILE" ||
        fail "$DEPLOY_USER cannot read $JWKS_FILE"
}

test_source() {
    "$NODE_BIN" --test "$REPO_DIR"/deploy/tests/*.test.mjs
    (
        cd "$SOURCE_API"
        npm ci
        npm test
    )
}

stage_api_release() {
    API_STAGE="$(mktemp -d "$API_ROOT/api.next.XXXXXX")"
    rsync -a --delete \
        --exclude '/node_modules/' \
        --exclude '/test/' \
        --exclude '/.env' \
        --exclude '/.env.*' \
        --exclude '/.oidc/' \
        "$SOURCE_API/" \
        "$API_STAGE/"

    (
        cd "$API_STAGE"
        npm ci --omit=dev
    )
    chmod -R u=rwX,g=rX,o= "$API_STAGE"
}

stage_portal_release() {
    PORTAL_STAGE="$(sudo mktemp -d /var/www/rinolab.next.XXXXXX)"
    sudo chown "$DEPLOY_USER:$CADDY_GROUP" "$PORTAL_STAGE"
    sudo rsync -a --delete --chown="$DEPLOY_USER:$CADDY_GROUP" \
        "$SOURCE_PORTAL/" \
        "$PORTAL_STAGE/"
    sudo find "$PORTAL_STAGE" -type d -exec chmod 0750 {} +
    sudo find "$PORTAL_STAGE" -type f -exec chmod 0640 {} +
}

activate_release() {
    if sudo systemctl is-active --quiet "$API_SERVICE"; then
        SERVICE_WAS_ACTIVE=1
    fi
    SERVICE_WAS_ENABLED="$(sudo systemctl is-enabled "$API_SERVICE" 2> /dev/null || true)"
    ACTIVATION_STARTED=1

    if sudo test -f "$ENV_FILE"; then
        sudo cp -p "$ENV_FILE" "$ENV_PREVIOUS"
        ENV_WAS_PRESENT=1
    fi
    # install can truncate the destination before failing, so record intent first.
    ENV_CHANGED=1
    sudo install -o root -g "$DEPLOY_USER" -m 0640 "$ENV_STAGE" "$ENV_FILE"
    rm -f -- "$ENV_STAGE"
    ENV_STAGE=""

    sudo rm -f -- "$SERVICE_PREVIOUS" "$SERVICE_PREVIOUS_ABSENT"
    if sudo test -f "$SERVICE_CONFIG"; then
        sudo cp -p "$SERVICE_CONFIG" "$SERVICE_PREVIOUS"
        UNIT_WAS_PRESENT=1
    else
        sudo touch "$SERVICE_PREVIOUS_ABSENT"
    fi
    UNIT_CHANGED=1
    sudo install -o root -g root -m 0644 "$SOURCE_SERVICE" "$SERVICE_CONFIG"
    sudo systemctl daemon-reload
    SERVICE_ENABLE_CHANGED=1
    sudo systemctl enable "$API_SERVICE"

    if [ -e "$API_PREVIOUS" ]; then
        rm -rf -- "$API_PREVIOUS"
    fi
    if [ -e "$API_DIR" ]; then
        API_WAS_PRESENT=1
    fi
    API_CHANGED=1
    if [ "$API_WAS_PRESENT" = "1" ]; then
        mv "$API_DIR" "$API_PREVIOUS"
    fi
    mv "$API_STAGE" "$API_DIR"
    API_STAGE=""

    if sudo test -e "$PORTAL_PREVIOUS"; then
        sudo rm -rf -- "$PORTAL_PREVIOUS"
    fi
    if sudo test -e "$PORTAL_ROOT"; then
        PORTAL_WAS_PRESENT=1
    fi
    PORTAL_CHANGED=1
    if [ "$PORTAL_WAS_PRESENT" = "1" ]; then
        sudo mv "$PORTAL_ROOT" "$PORTAL_PREVIOUS"
    fi
    sudo mv "$PORTAL_STAGE" "$PORTAL_ROOT"
    PORTAL_STAGE=""
}

rollback_deployment() {
    local failed=0
    local restore_service=0
    log_error "Deployment failed; restoring changes from this deployment"

    # The EXIT handler disables errexit. Check every recovery operation explicitly
    # and continue restoring independent components after any recovery failure.
    if [ "$ENV_CHANGED" = "1" ] || [ "$UNIT_CHANGED" = "1" ] || [ "$API_CHANGED" = "1" ]; then
        restore_service=1
        if [ "$SERVICE_WAS_ACTIVE" = "1" ] || [ "$SERVICE_START_ATTEMPTED" = "1" ]; then
            sudo systemctl stop "$API_SERVICE" || failed=1
        fi
    fi
    if [ "$API_CHANGED" = "1" ]; then
        restore_release_directory "$API_DIR" "$API_PREVIOUS" \
            "$API_ROOT/api.failed.$DEPLOY_ID" "$API_WAS_PRESENT" || failed=1
    fi
    if [ "$PORTAL_CHANGED" = "1" ]; then
        restore_release_directory "$PORTAL_ROOT" "$PORTAL_PREVIOUS" \
            "${PORTAL_ROOT}.failed.$DEPLOY_ID" "$PORTAL_WAS_PRESENT" || failed=1
    fi
    if [ "$ENV_CHANGED" = "1" ]; then
        if [ "$ENV_WAS_PRESENT" = "1" ]; then
            sudo cp -p "$ENV_PREVIOUS" "$ENV_FILE" || failed=1
        else
            sudo rm -f -- "$ENV_FILE" || failed=1
        fi
    fi
    if [ "$SERVICE_ENABLE_CHANGED" = "1" ]; then
        sudo systemctl disable "$API_SERVICE" || failed=1
    fi
    if [ "$UNIT_CHANGED" = "1" ]; then
        if [ "$UNIT_WAS_PRESENT" = "1" ]; then
            sudo cp -p "$SERVICE_PREVIOUS" "$SERVICE_CONFIG" || failed=1
        else
            sudo rm -f -- "$SERVICE_CONFIG" || failed=1
        fi
        sudo systemctl daemon-reload || failed=1
    fi
    if [ "$SERVICE_ENABLE_CHANGED" = "1" ]; then
        case "$SERVICE_WAS_ENABLED" in
            enabled) sudo systemctl enable "$API_SERVICE" || failed=1 ;;
            enabled-runtime) sudo systemctl enable --runtime "$API_SERVICE" || failed=1 ;;
        esac
    fi
    if [ "$CADDY_CHANGED" = "1" ]; then
        sudo cp -p "${CADDY_CONFIG}.bak" "$CADDY_CONFIG" || failed=1
        sudo systemctl reload caddy || failed=1
    fi
    if [ "$restore_service" = "1" ] && [ "$SERVICE_WAS_ACTIVE" = "1" ]; then
        sudo systemctl restart "$API_SERVICE" || failed=1
    fi

    if [ "$failed" -ne 0 ]; then
        log_error "Rollback did not complete successfully"
    fi
    return "$failed"
}

restart_and_verify_api() {
    SERVICE_START_ATTEMPTED=1
    sudo systemctl restart "$API_SERVICE"
    bash "$HEALTH_CHECK_SCRIPT"
}

deploy_caddy_config() {
    local caddy_backup="${CADDY_CONFIG}.bak"

    sudo test -f "$CADDY_CONFIG" ||
        fail "Installed Caddy config not found: $CADDY_CONFIG"

    sudo cp -p "$CADDY_CONFIG" "$caddy_backup"
    CADDY_CHANGED=1
    sudo install -o root -g root -m 0644 "$SOURCE_CADDY" "$CADDY_CONFIG"
    sudo systemctl reload caddy
}

main() {
    assert_deploy_user
    require_commands flock install sudo
    sudo -v
    # Only create the lock's parent before locking; shared source and releases
    # must not change until this process owns the lock.
    sudo install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0750 "$API_ROOT"
    acquire_deploy_lock

    log "[1/8] Fetch and checkout source"
    preserve_legacy_environment
    checkout_source

    log "[2/8] Run deployment preflight"
    run_preflight

    log "[3/8] Install source dependencies and run tests"
    test_source

    log "[4/8] Prepare production API"
    stage_api_release

    log "[5/8] Prepare portal files"
    stage_portal_release

    log "[6/8] Activate API and portal release"
    activate_release

    log "[7/8] Restart and check API health"
    restart_and_verify_api

    log "[8/8] Deploy and reload Caddy"
    deploy_caddy_config

    ACTIVATION_STARTED=0
    log "Deploy complete: $(git -C "$REPO_DIR" rev-parse --short HEAD)"
}

trap finish_deployment EXIT
trap 'handle_unexpected_error "$?" "$LINENO" "${BASH_SOURCE[0]}"' ERR
trap 'exit 130' INT
trap 'exit 143' TERM

main "$@"
