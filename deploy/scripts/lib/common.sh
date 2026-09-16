#!/usr/bin/env bash

# Shared constants and small utilities for Rinolab deployment scripts.

readonly COMMON_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPTS_DIR="$(cd -- "$COMMON_DIR/.." && pwd -P)"
readonly DEPLOY_DIR="$(cd -- "$SCRIPTS_DIR/.." && pwd -P)"
readonly LOCAL_REPO_DIR="$(cd -- "$DEPLOY_DIR/.." && pwd -P)"

if [ -n "${RINOLAB_REPO_DIR:-}" ]; then
    REPO_DIR="$RINOLAB_REPO_DIR"
elif [ -e "$LOCAL_REPO_DIR/.git" ] && \
    [ -f "$LOCAL_REPO_DIR/api/package.json" ] && \
    [ -d "$LOCAL_REPO_DIR/deploy" ]; then
    REPO_DIR="$LOCAL_REPO_DIR"
else
    REPO_DIR="/srv/nas/shared/gwnam/source/rinolab"
fi

readonly REPO_DIR
readonly DEPLOY_USER="gwnam"
readonly CADDY_GROUP="caddy"

readonly REPO_URL="git@github.com:rino0914/rinolab.git"
readonly DEPLOY_BRANCH="main"
readonly NODE_BIN="/usr/bin/node"

readonly SOURCE_API="$REPO_DIR/api"
readonly SOURCE_PORTAL="$REPO_DIR/portal"
readonly SOURCE_CADDY="$REPO_DIR/deploy/caddy/Caddyfile"
readonly SOURCE_SERVICE="$REPO_DIR/deploy/systemd/rinolab-api.service"

readonly API_ROOT="/opt/rinolab"
readonly API_DIR="$API_ROOT/api"
readonly API_PREVIOUS="$API_ROOT/api.previous"
readonly DEPLOY_LOCK_FILE="$API_ROOT/.deploy.lock"

readonly PORTAL_ROOT="/var/www/rinolab"
readonly PORTAL_PREVIOUS="/var/www/rinolab.previous"

readonly ENV_FILE="/etc/rinolab/api.env"
readonly ENV_PREVIOUS="/etc/rinolab/api.env.previous"
readonly JWKS_FILE="/etc/rinolab/oidc-jwks.json"
readonly SOURCE_ENV="$SOURCE_API/.env.prd"
readonly LEGACY_JWKS_FILE="/opt/rinolab/secrets/oidc-jwks.json"

readonly CADDY_CONFIG="/etc/caddy/Caddyfile"
readonly SERVICE_CONFIG="/etc/systemd/system/rinolab-api.service"
readonly API_SERVICE="rinolab-api"

readonly HEALTH_URL="http://127.0.0.1:3000/api/health"
readonly HEALTH_ATTEMPTS=10
readonly HEALTH_INTERVAL_SECONDS=1

readonly HEALTH_CHECK_SCRIPT="$SCRIPTS_DIR/health-check.sh"
readonly ROLLBACK_SCRIPT="$SCRIPTS_DIR/rollback.sh"

log() {
    printf '%s\n' "$*"
}

log_error() {
    printf 'ERROR: %s\n' "$*" >&2
}

log_warning() {
    printf 'WARNING: %s\n' "$*" >&2
}

fail() {
    log_error "$*"
    exit 1
}

require_commands() {
    local command_name

    for command_name in "$@"; do
        command -v "$command_name" > /dev/null 2>&1 ||
            fail "Required command not found: $command_name"
    done
}

assert_deploy_user() {
    [ "$(id -un)" = "$DEPLOY_USER" ] ||
        fail "Run this script as $DEPLOY_USER; do not run the entire script with sudo"
}

acquire_deploy_lock() {
    [ -d "$API_ROOT" ] || fail "Runtime root not found: $API_ROOT"

    exec 9> "$DEPLOY_LOCK_FILE"
    flock -n 9 || fail "Another Rinolab deployment or rollback is already running"
}

handle_unexpected_error() {
    local status="$1"
    local line="$2"
    local script="$3"

    trap - ERR
    log_error "Unexpected failure in $script at line $line (exit $status)"
    exit "$status"
}
