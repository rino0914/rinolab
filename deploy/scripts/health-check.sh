#!/usr/bin/env bash

set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

main() {
    local attempt

    require_commands curl sleep
    log "Checking API health: $HEALTH_URL"

    for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt += 1)); do
        if curl --fail --silent \
            --connect-timeout "$HEALTH_CONNECT_TIMEOUT_SECONDS" \
            --max-time "$HEALTH_TIMEOUT_SECONDS" "$HEALTH_URL" > /dev/null; then
            log "API health check passed on attempt $attempt"
            return 0
        fi

        if [ "$attempt" -lt "$HEALTH_ATTEMPTS" ]; then
            sleep "$HEALTH_INTERVAL_SECONDS"
        fi
    done

    log_error "API health check failed after $HEALTH_ATTEMPTS attempts"
    return 1
}

main "$@"
