#!/usr/bin/env bash
set -Eeuo pipefail
exec 2>/dev/null
trap 'printf "%s\n" "Zephium backup notification failed"; exit 1' ERR
# shellcheck source=common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
[[ $# == 2 ]]
case "$1" in backup_failed|backup_monitor_failed) event=$1 ;; *) exit 1 ;; esac
load_config "$2"
exec 9>"$STATE_DIRECTORY/alerts.lock"
flock --wait 5 9
now=$(date +%s)
stamp="$STATE_DIRECTORY/$event.last-attempt"
last=0
if [[ -f "$stamp" ]]; then
  read -r last < "$stamp"
  [[ "$last" =~ ^[0-9]{1,12}$ ]]
fi
if [[ "$last" -le "$now" && $((now - last)) -lt 3600 ]]; then
  exit 0
fi
# Rate-limit attempts, including failures. No self-triggering OnFailure notification loop.
printf '%s\n' "$now" > "$stamp"
container=$(select_container "$WORKER_SERVICE")
# Worker keeps its existing OPERATIONS_WEBHOOK; no host secret env file is read.
timeout --kill-after=5s 20s docker exec --user bun --workdir /app "$container" \
  timeout --kill-after=3s 10s bun scripts/notify.ts "$event" >/dev/null
printf '%s\n' 'Zephium backup notification delivered'
