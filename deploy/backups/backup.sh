#!/usr/bin/env bash
set -Eeuo pipefail
exec 2>/dev/null
trap 'printf "%s\n" "Zephium backup failed"; exit 1' ERR
# shellcheck source=common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
[[ $# == 2 ]]
case "$1" in full|diff) backup_type=$1 ;; *) exit 1 ;; esac
load_config "$2"
exec 9>"$STATE_DIRECTORY/backup.lock"
# A concurrent backup owns this deployment; do not start a second one.
if flock --conflict-exit-code 75 --wait 5 9; then
  :
else
  lock_status=$?
  if [[ "$lock_status" == 75 ]]; then
    printf '%s\n' 'Zephium backup already running'
    exit 0
  fi
  false
fi
container=$(select_container "$POSTGRES_SERVICE")
# Container timeout is essential: terminating only docker exec may leave its command alive.
timeout --kill-after=30s 2800s docker exec --user postgres "$container" \
  timeout --kill-after=15s 2700s pgbackrest \
  --config=/etc/pgbackrest/pgbackrest.conf --stanza="$PGBACKREST_STANZA" --repo=1 \
  --log-level-console=off --log-level-stderr=off --log-level-file=off \
  --archive-check --type="$backup_type" backup >/dev/null
printf '%s\n' 'Zephium backup completed'
