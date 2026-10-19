#!/usr/bin/env bash
set -Eeuo pipefail
exec 2>/dev/null
trap 'printf "%s\n" "Zephium backup monitor failed"; exit 1' ERR
# shellcheck source=common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
[[ $# == 1 ]]
load_config "$1"
container=$(select_container "$POSTGRES_SERVICE")
# Do not emit repository metadata or error details. Parse at most 1 MiB into two epochs only.
timestamps=$(timeout --kill-after=5s 45s docker exec --user postgres "$container" \
  timeout --kill-after=5s 35s pgbackrest \
  --config=/etc/pgbackrest/pgbackrest.conf --stanza="$PGBACKREST_STANZA" --repo=1 \
  --log-level-console=off --log-level-stderr=off --log-level-file=off --output=json info | \
  python3 -c '
import json, sys
raw = sys.stdin.buffer.read(1048577)
if len(raw) > 1048576:
    raise ValueError()
rows = json.loads(raw)
if not isinstance(rows, list) or len(rows) != 1:
    raise ValueError()
stanza = rows[0]
if stanza.get("name") != sys.argv[1] or stanza.get("status", {}).get("code") != 0:
    raise ValueError()
backups = stanza.get("backup")
if not isinstance(backups, list):
    raise ValueError()
successful = [b for b in backups if b.get("error") is False]
stops = [b.get("timestamp", {}).get("stop") for b in successful]
full_stops = [b.get("timestamp", {}).get("stop") for b in successful if b.get("type") == "full"]
if not stops or not full_stops or any(type(t) is not int or t <= 0 for t in stops):
    raise ValueError()
print(str(max(stops)) + "|" + str(max(full_stops)))
' "$PGBACKREST_STANZA")
[[ "$timestamps" =~ ^[0-9]{1,12}\|[0-9]{1,12}$ ]]
latest=${timestamps%%|*}
latest_full=${timestamps#*|}
now=$(date +%s)
[[ "$latest" -le "$now" && $((now - latest)) -le 108000 ]]
[[ "$latest_full" -le "$now" && $((now - latest_full)) -le 691200 ]]
# Local socket/owner identity stays inside the container. No connection URL or secret is loaded.
# PostgreSQL returns only one boolean and one byte count, never WAL names or data contents.
metrics=$(timeout --kill-after=5s 25s docker exec --user postgres \
  --env PGCONNECT_TIMEOUT=5 \
  --env 'PGOPTIONS=-c statement_timeout=10000 -c default_transaction_read_only=on' \
  "$container" timeout --kill-after=5s 15s psql -X -qAt --no-password \
  --username="$POSTGRES_USER" --dbname="$POSTGRES_DATABASE" --set=ON_ERROR_STOP=1 \
  --command="SELECT (current_setting('archive_mode') = 'on' AND last_archived_time IS NOT NULL AND (last_failed_time IS NULL OR last_failed_time <= last_archived_time))::int::text || '|' || (SELECT coalesce(sum(size),0)::text FROM pg_ls_waldir()) FROM pg_stat_archiver")
[[ "$metrics" =~ ^1\|[0-9]{1,15}$ ]]
wal_bytes=${metrics#*|}
[[ "$wal_bytes" -le "$MAX_WAL_BYTES" ]]
disk_ok=$(timeout --kill-after=5s 10s env LC_ALL=C df -Pk -- "$HOST_DISK_PATH" | \
  awk 'NR == 2 && $2 > 0 { print ($4 * 100 >= $2 * 15) ? 1 : 0; found=1 } END { if (!found) exit 1 }')
[[ "$disk_ok" == 1 ]]
printf '%s\n' 'Zephium backup monitor passed'
