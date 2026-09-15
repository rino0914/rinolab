#!/usr/bin/env bash

set -Eeuo pipefail
umask 027

readonly DEPLOY_USER="gwnam"
readonly WEB_GROUP="caddy"

readonly REPO_URL="git@github.com:rino0914/rinolab.git"
readonly DEPLOY_BRANCH="main"
readonly REPO_DIR="/srv/nas/shared/gwnam/source/rinolab"
readonly NODE_BIN="/usr/bin/node"
readonly SOURCE_API="$REPO_DIR/api"
readonly SOURCE_WEB="$REPO_DIR/web"
readonly SOURCE_CADDY="$REPO_DIR/deploy/Caddyfile"
readonly SOURCE_SERVICE="$REPO_DIR/deploy/rinolab-api.service"

readonly API_ROOT="/opt/rinolab"
readonly API_DIR="$API_ROOT/api"
readonly API_PREVIOUS="$API_ROOT/api.previous"
readonly WEB_ROOT="/var/www/rinolab"
readonly WEB_PREVIOUS="/var/www/rinolab.previous"

readonly ENV_FILE="/etc/rinolab/api.env"
readonly JWKS_FILE="/etc/rinolab/oidc-jwks.json"
readonly SOURCE_ENV="$SOURCE_API/.env.prd"
readonly LEGACY_JWKS_FILE="/opt/rinolab/secrets/oidc-jwks.json"
readonly CADDY_CONFIG="/etc/caddy/Caddyfile"
readonly SERVICE_CONFIG="/etc/systemd/system/rinolab-api.service"
readonly HEALTH_URL="http://127.0.0.1:3000/api/health"

API_STAGE=""
WEB_STAGE=""
ENV_STAGE=""
DEPLOY_ID="$(date -u +%Y%m%dT%H%M%SZ)"

fail() {
    echo "ERROR: $*" >&2
    exit 1
}

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

    for secret_name in \
        MONGODB_URI \
        SESSION_SECRET \
        OIDC_COOKIE_KEYS \
        OIDC_CLIENT_SECRET; do
        secret_value="$(read_env_value "$ENV_STAGE" "$secret_name")"
        if [ -z "$secret_value" ] || [[ "$secret_value" == *CHANGE_ME* ]]; then
            missing_secrets="${missing_secrets}${missing_secrets:+, }${secret_name}"
        fi
    done

    [ -z "$missing_secrets" ] ||
        fail "Set these values in $ENV_FILE, then run deployment again: $missing_secrets"
}

cleanup() {
    if [ -n "${API_STAGE:-}" ] && [ -d "$API_STAGE" ]; then
        rm -rf -- "$API_STAGE"
    fi
    if [ -n "${WEB_STAGE:-}" ] && sudo test -d "$WEB_STAGE"; then
        sudo rm -rf -- "$WEB_STAGE"
    fi
    if [ -n "${ENV_STAGE:-}" ] && [ -f "$ENV_STAGE" ]; then
        rm -f -- "$ENV_STAGE"
    fi
}

rollback_release() {
    local failed_api="$API_ROOT/api.failed.$DEPLOY_ID"
    local failed_web="/var/www/rinolab.failed.$DEPLOY_ID"

    echo "API health check failed; rolling back the deployed files" >&2
    sudo systemctl stop rinolab-api || true

    if [ -e "$API_PREVIOUS" ]; then
        if [ -e "$API_DIR" ]; then
            mv "$API_DIR" "$failed_api"
        fi
        mv "$API_PREVIOUS" "$API_DIR"
    fi

    if sudo test -e "$WEB_PREVIOUS"; then
        if sudo test -e "$WEB_ROOT"; then
            sudo mv "$WEB_ROOT" "$failed_web"
        fi
        sudo mv "$WEB_PREVIOUS" "$WEB_ROOT"
    fi

    if [ -e "$API_DIR/src/server.js" ]; then
        sudo systemctl restart rinolab-api || true
    fi
}

trap cleanup EXIT

echo "[1/8] Fetch and checkout source"

[ "$(id -un)" = "$DEPLOY_USER" ] ||
    fail "Run this script as $DEPLOY_USER; do not run the entire script with sudo"

# Preserve a legacy ignored .env.prd before Git starts tracking and replacing it.
if [ -f "$SOURCE_ENV" ] && ! sudo test -f "$ENV_FILE"; then
    echo "Preserving the existing production environment before checkout"
    sudo install -d -o root -g "$DEPLOY_USER" -m 0750 /etc/rinolab
    sudo install -o root -g "$DEPLOY_USER" -m 0640 \
        "$SOURCE_ENV" "$ENV_FILE"
fi

if ! git -C "$REPO_DIR" rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    echo "Repository not found; cloning $REPO_URL"
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
echo "Deploying commit: $(git -C "$REPO_DIR" rev-parse --short HEAD)"

echo "[2/8] Run deployment preflight"

for command in awk caddy cp curl find flock getent git install mktemp npm rsync sudo systemctl; do
    command -v "$command" > /dev/null 2>&1 || fail "Required command not found: $command"
done

if [ ! -x "$NODE_BIN" ]; then
    fail "Node.js executable not found: $NODE_BIN"
fi

if ! "$NODE_BIN" -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit((major === 22 && minor >= 1) || major === 24 ? 0 : 1);
'; then
    fail "Unsupported Node.js version: $($NODE_BIN --version 2> /dev/null || echo not-installed); use Node.js 22.1+ or 24.x LTS"
fi

[ -r "$SOURCE_API/package-lock.json" ] || fail "API source is incomplete: $SOURCE_API"
[ -d "$SOURCE_WEB" ] || fail "Web source not found: $SOURCE_WEB"
[ -r "$SOURCE_CADDY" ] || fail "Caddy source config not found: $SOURCE_CADDY"
[ -r "$SOURCE_SERVICE" ] || fail "systemd source unit not found: $SOURCE_SERVICE"
[ -r "$SOURCE_ENV" ] || fail "Production environment config not found: $SOURCE_ENV"

sudo -v
getent group "$WEB_GROUP" > /dev/null || fail "Required group not found: $WEB_GROUP"

sudo install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0750 "$API_ROOT"
sudo install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0750 "$API_DIR"
sudo install -d -o root -g "$DEPLOY_USER" -m 0750 /etc/rinolab
sudo install -d -o "$DEPLOY_USER" -g "$WEB_GROUP" -m 0750 "$WEB_ROOT"

exec 9> "$API_ROOT/.deploy.lock"
flock -n 9 || fail "Another Rinolab deployment is already running"

prepare_environment

if ! sudo test -f "$JWKS_FILE"; then
    if sudo test -f "$LEGACY_JWKS_FILE"; then
        echo "Migrating legacy OIDC JWKS"
        sudo install -o root -g "$DEPLOY_USER" -m 0640 \
            "$LEGACY_JWKS_FILE" "$JWKS_FILE"
    else
        echo "Generating persistent OIDC JWKS"
        sudo "$NODE_BIN" "$SOURCE_API/scripts/generate-oidc-key.js" "$JWKS_FILE"
    fi
fi

sudo chown root:"$DEPLOY_USER" "$JWKS_FILE"
sudo chmod 0640 "$JWKS_FILE"

sudo -u "$DEPLOY_USER" test -r "$JWKS_FILE" ||
    fail "$DEPLOY_USER cannot read $JWKS_FILE"

sudo caddy validate --config "$SOURCE_CADDY"

if command -v systemd-analyze > /dev/null 2>&1; then
    sudo systemd-analyze verify "$SOURCE_SERVICE"
fi

echo "[3/8] Install source dependencies and run tests"
(
    cd "$SOURCE_API"
    npm ci
    npm test
)

echo "[4/8] Prepare production API"
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

echo "[5/8] Prepare web files"
WEB_STAGE="$(sudo mktemp -d /var/www/rinolab.next.XXXXXX)"
sudo chown "$DEPLOY_USER:$WEB_GROUP" "$WEB_STAGE"
sudo rsync -a --delete --chown="$DEPLOY_USER:$WEB_GROUP" \
    "$SOURCE_WEB/" \
    "$WEB_STAGE/"
sudo find "$WEB_STAGE" -type d -exec chmod 0750 {} +
sudo find "$WEB_STAGE" -type f -exec chmod 0640 {} +

echo "[6/8] Activate API and web release"
sudo install -o root -g "$DEPLOY_USER" -m 0640 "$ENV_STAGE" "$ENV_FILE"
ENV_STAGE=""
sudo install -o root -g root -m 0644 "$SOURCE_SERVICE" "$SERVICE_CONFIG"
sudo systemctl daemon-reload
sudo systemctl enable rinolab-api

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

if sudo test -e "$WEB_PREVIOUS"; then
    sudo rm -rf -- "$WEB_PREVIOUS"
fi
sudo mv "$WEB_ROOT" "$WEB_PREVIOUS"
sudo mv "$WEB_STAGE" "$WEB_ROOT"
WEB_STAGE=""

if ! sudo systemctl restart rinolab-api; then
    rollback_release
    fail "Failed to restart rinolab-api"
fi

echo "[7/8] Check API health"
health_ok=false
for attempt in {1..10}; do
    if curl --fail --silent "$HEALTH_URL" > /dev/null; then
        health_ok=true
        echo "API health check passed on attempt $attempt"
        break
    fi
    sleep 1
done

if [ "$health_ok" != true ]; then
    rollback_release
    fail "API health check failed after 10 attempts"
fi

echo "[8/8] Deploy and reload Caddy"
CADDY_BACKUP="${CADDY_CONFIG}.bak"

if ! sudo test -f "$CADDY_CONFIG"; then
    fail "Installed Caddy config not found: $CADDY_CONFIG"
fi

sudo cp -p "$CADDY_CONFIG" "$CADDY_BACKUP"
sudo install -o root -g root -m 0644 "$SOURCE_CADDY" "$CADDY_CONFIG"

if ! sudo systemctl reload caddy; then
    echo "Caddy reload failed; restoring previous config" >&2
    sudo cp -p "$CADDY_BACKUP" "$CADDY_CONFIG"
    sudo systemctl reload caddy || true
    fail "Failed to reload Caddy"
fi

echo "Deploy complete: $(git -C "$REPO_DIR" rev-parse --short HEAD)"
