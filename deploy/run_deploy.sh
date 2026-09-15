#!/usr/bin/env bash

set -Eeuo pipefail

CONF_CADDY="/etc/caddy/Caddyfile"
WEB_ROOT="/var/www/rinolab"
REPO_DIR="/srv/nas/shared/gwnam/source/rinolab"
SOURCE_CADDY="$REPO_DIR/deploy/Caddyfile"
DEPLOY_REF="${DEPLOY_REF:-origin/main}"

echo "[1/7] Fetch and checkout source"

if [ -n "$(git -C "$REPO_DIR" status --porcelain)" ]; then
    echo "Repository has local changes; refusing to overwrite them"
    git -C "$REPO_DIR" status --short
    exit 1
fi

git -C "$REPO_DIR" fetch --prune origin
git -C "$REPO_DIR" checkout --detach "$DEPLOY_REF"
echo "Deploying commit: $(git -C "$REPO_DIR" rev-parse --short HEAD)"

echo "[2/7] Install API dependencies"
cd "$REPO_DIR/api"
npm ci

echo "[3/7] Run tests"
npm test

echo "[4/7] Deploy web"
sudo rsync -a --delete \
    "$REPO_DIR/web/" \
    "$WEB_ROOT/"

echo "[5/7] Restart API"
sudo systemctl restart rinolab-api

echo "[6/7] Check API health"

for i in {1..10}; do
    if curl --fail --silent \
        http://127.0.0.1:3000/api/health > /dev/null; then
        echo "API health check passed"
        break
    fi

    if [ "$i" -eq 10 ]; then
        echo "API health check failed"
        exit 1
    fi

    sleep 1
done

echo "[7/7] Deploy, validate and reload Caddy"

if [ ! -r "$SOURCE_CADDY" ]; then
    echo "Caddy source config not found: $SOURCE_CADDY"
    exit 1
fi

# Validate the new config before changing the currently installed config.
sudo caddy validate --config "$SOURCE_CADDY"

if ! sudo test -f "$CONF_CADDY"; then
    echo "Installed Caddy config not found: $CONF_CADDY"
    exit 1
fi

CADDY_BACKUP="${CONF_CADDY}.bak"
sudo cp -p "$CONF_CADDY" "$CADDY_BACKUP"
sudo install -o root -g root -m 0644 "$SOURCE_CADDY" "$CONF_CADDY"

if ! sudo systemctl reload caddy; then
    echo "Caddy reload failed; restoring previous config"
    sudo cp -p "$CADDY_BACKUP" "$CONF_CADDY"
    sudo systemctl reload caddy || true
    exit 1
fi

echo "Deploy complete"
