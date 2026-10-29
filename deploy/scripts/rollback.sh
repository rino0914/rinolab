#!/usr/bin/env bash

set -Eeuo pipefail
umask 027

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

readonly DEPLOY_ID="${RINOLAB_DEPLOY_ID:-$(date -u +%Y%m%dT%H%M%SZ).$$}"

trap 'handle_unexpected_error "$?" "$LINENO" "${BASH_SOURCE[0]}"' ERR

main() {
    local failed_api="$API_ROOT/api.failed.$DEPLOY_ID"
    local failed_portal="${PORTAL_ROOT}.failed.$DEPLOY_ID"

    assert_deploy_user
    require_commands cp date flock mv sudo systemctl
    sudo -v

    if [ "${RINOLAB_DEPLOY_LOCK_HELD:-0}" != "1" ]; then
        acquire_deploy_lock
    fi

    if [ ! -e "$API_PREVIOUS" ] && ! sudo test -e "$PORTAL_PREVIOUS"; then
        fail "No previous API or portal release is available for rollback"
    fi

    log "Rolling back the deployed API, portal, environment, and service unit"
    sudo systemctl stop "$API_SERVICE" || true

    if sudo test -f "$ENV_PREVIOUS"; then
        sudo cp -p "$ENV_PREVIOUS" "$ENV_FILE"
        log "Restored the previous production environment"
    else
        log_warning "Previous environment file not found: $ENV_PREVIOUS"
    fi

    if [ -e "$API_PREVIOUS" ]; then
        restore_release_directory "$API_DIR" "$API_PREVIOUS" "$failed_api" 1
        log "Restored the previous API release"
    else
        log_warning "Previous API release not found: $API_PREVIOUS"
    fi

    if sudo test -e "$PORTAL_PREVIOUS"; then
        restore_release_directory "$PORTAL_ROOT" "$PORTAL_PREVIOUS" "$failed_portal" 1
        log "Restored the previous portal release"
    else
        log_warning "Previous portal release not found: $PORTAL_PREVIOUS"
    fi

    if sudo test -f "$SERVICE_PREVIOUS"; then
        sudo cp -p "$SERVICE_PREVIOUS" "$SERVICE_CONFIG"
        sudo systemctl daemon-reload
        log "Restored the previous service unit"
    elif sudo test -f "$SERVICE_PREVIOUS_ABSENT"; then
        sudo systemctl disable "$API_SERVICE"
        sudo rm -f -- "$SERVICE_CONFIG"
        sudo systemctl daemon-reload
    else
        log_warning "Previous service unit not found: $SERVICE_PREVIOUS"
    fi

    if [ ! -e "$API_DIR/src/server.js" ]; then
        fail "Restored API entry point not found: $API_DIR/src/server.js"
    fi

    sudo systemctl restart "$API_SERVICE"
    log "Rollback complete"
}

main "$@"
