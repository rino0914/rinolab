#!/usr/bin/env bash

set -Eeuo pipefail
umask 027

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

readonly DEPLOY_ID="${RINOLAB_DEPLOY_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"

trap 'handle_unexpected_error "$?" "$LINENO" "${BASH_SOURCE[0]}"' ERR

main() {
    local failed_api="$API_ROOT/api.failed.$DEPLOY_ID"
    local failed_portal="/var/www/rinolab.failed.$DEPLOY_ID"

    assert_deploy_user
    require_commands cp date flock mv sudo systemctl
    sudo -v

    if [ "${RINOLAB_DEPLOY_LOCK_HELD:-0}" != "1" ]; then
        acquire_deploy_lock
    fi

    if [ ! -e "$API_PREVIOUS" ] && ! sudo test -e "$PORTAL_PREVIOUS"; then
        fail "No previous API or portal release is available for rollback"
    fi

    log "Rolling back the deployed API, portal, and environment"
    sudo systemctl stop "$API_SERVICE" || true

    if sudo test -f "$ENV_PREVIOUS"; then
        sudo cp -p "$ENV_PREVIOUS" "$ENV_FILE"
        log "Restored the previous production environment"
    else
        log_warning "Previous environment file not found: $ENV_PREVIOUS"
    fi

    if [ -e "$API_PREVIOUS" ]; then
        if [ -e "$API_DIR" ]; then
            mv "$API_DIR" "$failed_api"
        fi
        mv "$API_PREVIOUS" "$API_DIR"
        log "Restored the previous API release"
    else
        log_warning "Previous API release not found: $API_PREVIOUS"
    fi

    if sudo test -e "$PORTAL_PREVIOUS"; then
        if sudo test -e "$PORTAL_ROOT"; then
            sudo mv "$PORTAL_ROOT" "$failed_portal"
        fi
        sudo mv "$PORTAL_PREVIOUS" "$PORTAL_ROOT"
        log "Restored the previous portal release"
    else
        log_warning "Previous portal release not found: $PORTAL_PREVIOUS"
    fi

    if [ ! -e "$API_DIR/src/server.js" ]; then
        fail "Restored API entry point not found: $API_DIR/src/server.js"
    fi

    sudo systemctl restart "$API_SERVICE"
    log "Rollback complete"
}

main "$@"
