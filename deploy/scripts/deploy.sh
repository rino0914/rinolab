#!/usr/bin/env bash

set -Eeuo pipefail
umask 027

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

API_STAGE=""
PORTAL_STAGE=""
ENV_STAGE=""
readonly DEPLOY_ID="$(date -u +%Y%m%dT%H%M%SZ)"

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

    sudo install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0750 "$API_ROOT"
    sudo install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0750 "$API_DIR"
    sudo install -d -o root -g "$DEPLOY_USER" -m 0750 /etc/rinolab
    sudo install -d -o "$DEPLOY_USER" -g "$CADDY_GROUP" -m 0750 "$PORTAL_ROOT"

    acquire_deploy_lock
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
    sudo cp -p "$ENV_FILE" "$ENV_PREVIOUS"
    sudo install -o root -g "$DEPLOY_USER" -m 0640 "$ENV_STAGE" "$ENV_FILE"
    ENV_STAGE=""

    sudo install -o root -g root -m 0644 "$SOURCE_SERVICE" "$SERVICE_CONFIG"
    sudo systemctl daemon-reload
    sudo systemctl enable "$API_SERVICE"

    if [ -e "$API_PREVIOUS" ]; then
        rm -rf -- "$API_PREVIOUS"
    fi
    if [ -d "$API_DIR" ] && [ -n "$(find "$API_DIR" -mindepth 1 -print -quit)" ]; then
        mv "$API_DIR" "$API_PREVIOUS"
    elif [ -d "$API_DIR" ]; then
        rmdir "$API_DIR"
    fi
    mv "$API_STAGE" "$API_DIR"
    API_STAGE=""

    if sudo test -e "$PORTAL_PREVIOUS"; then
        sudo rm -rf -- "$PORTAL_PREVIOUS"
    fi
    sudo mv "$PORTAL_ROOT" "$PORTAL_PREVIOUS"
    sudo mv "$PORTAL_STAGE" "$PORTAL_ROOT"
    PORTAL_STAGE=""
}

rollback_deployment() {
    log_error "Deployment verification failed; starting rollback"

    if ! (
        export RINOLAB_DEPLOY_LOCK_HELD=1
        export RINOLAB_DEPLOY_ID="$DEPLOY_ID"
        bash "$ROLLBACK_SCRIPT"
    ); then
        log_error "Rollback did not complete successfully"
    fi
}

restart_and_verify_api() {
    if ! sudo systemctl restart "$API_SERVICE"; then
        rollback_deployment
        fail "Failed to restart $API_SERVICE"
    fi

    if ! bash "$HEALTH_CHECK_SCRIPT"; then
        rollback_deployment
        fail "API health check failed"
    fi
}

deploy_caddy_config() {
    local caddy_backup="${CADDY_CONFIG}.bak"

    sudo test -f "$CADDY_CONFIG" ||
        fail "Installed Caddy config not found: $CADDY_CONFIG"

    sudo cp -p "$CADDY_CONFIG" "$caddy_backup"
    sudo install -o root -g root -m 0644 "$SOURCE_CADDY" "$CADDY_CONFIG"

    if ! sudo systemctl reload caddy; then
        log_error "Caddy reload failed; restoring previous config"
        sudo cp -p "$caddy_backup" "$CADDY_CONFIG"
        sudo systemctl reload caddy || true
        fail "Failed to reload Caddy"
    fi
}

main() {
    log "[1/8] Fetch and checkout source"
    assert_deploy_user
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

    log "Deploy complete: $(git -C "$REPO_DIR" rev-parse --short HEAD)"
}

trap cleanup EXIT
trap 'handle_unexpected_error "$?" "$LINENO" "${BASH_SOURCE[0]}"' ERR

main "$@"
