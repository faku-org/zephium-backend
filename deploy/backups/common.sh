#!/usr/bin/env bash
# Sourced only by the root-owned entry points; never source a deployment secret file.
load_config() {
  local config=$1 key value seen='|' permissions
  [[ -f "$config" && ! -L "$config" ]] || return 1
  permissions=$(stat -c '%u:%a' -- "$config") || return 1
  [[ "$permissions" == '0:600' ]] || return 1
  while IFS='=' read -r key value || [[ -n "$key" ]]; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    case "$key" in
      COMPOSE_PROJECT_UUID|POSTGRES_SERVICE|WORKER_SERVICE|PGBACKREST_STANZA|POSTGRES_DATABASE|POSTGRES_USER|MAX_WAL_BYTES|HOST_DISK_PATH) ;;
      *) return 1 ;;
    esac
    [[ "$seen" != *"|$key|"* ]] || return 1
    seen+="$key|"
    printf -v "$key" '%s' "$value" || return 1
  done < "$config"
  for key in COMPOSE_PROJECT_UUID POSTGRES_SERVICE WORKER_SERVICE PGBACKREST_STANZA POSTGRES_DATABASE POSTGRES_USER MAX_WAL_BYTES HOST_DISK_PATH; do
    [[ "$seen" == *"|$key|"* ]] || return 1
  done
  for key in COMPOSE_PROJECT_UUID POSTGRES_SERVICE WORKER_SERVICE PGBACKREST_STANZA POSTGRES_DATABASE POSTGRES_USER; do
    [[ "${!key:-}" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$ ]] || return 1
  done
  [[ "${MAX_WAL_BYTES:-}" =~ ^[1-9][0-9]{0,12}$ ]] || return 1
  [[ "${HOST_DISK_PATH:-}" =~ ^/[a-zA-Z0-9_./-]+$ && -d "$HOST_DISK_PATH" ]] || return 1
  STATE_DIRECTORY=${STATE_DIRECTORY:-/var/lib/zephium-backups}
  [[ "$STATE_DIRECTORY" == /* && -d "$STATE_DIRECTORY" && ! -L "$STATE_DIRECTORY" ]] || return 1
  permissions=$(stat -c '%u:%a' -- "$STATE_DIRECTORY") || return 1
  [[ "$permissions" == '0:700' ]] || return 1
  umask 077
}

select_container() {
  local service=$1 containers
  containers=$(timeout --kill-after=5s 15s docker ps --quiet --no-trunc \
    --filter status=running \
    --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_UUID" \
    --filter "label=com.docker.compose.service=$service") || return 1
  # Explicit guards also apply in command substitutions where errexit is disabled.
  [[ "$containers" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s' "$containers"
}
