# Production backup scheduler templates

These files are not installed or enabled. There is no production database to schedule yet. Keep all timers disabled until the production repository, first full backup, WAL archival, notification delivery and isolated off-server restore have been qualified. The separate qualification runner/runbook owns those checks.

The host needs Linux/systemd, Bash, Docker, GNU coreutils (`timeout`, `stat`, `df`), util-linux `flock`, awk and Python3. PostgreSQL and worker images must contain GNU `timeout`; verify that in the pinned images. The worker must already contain `scripts/notify.ts` and its private `OPERATIONS_WEBHOOK`. The database must already have its private pgBackRest configuration mounted read-only at `/etc/pgbackrest/pgbackrest.conf`. These scripts never source the production env or read a webhook, database password, S3 key or encryption passphrase on the host.

## Prepare without enabling timers

Review the files before installing. As a host operator, when the production resource exists:

```sh
install -d -o root -g root -m 0755 /usr/local/libexec/zephium-backups
install -o root -g root -m 0700 deploy/backups/common.sh deploy/backups/backup.sh deploy/backups/monitor.sh deploy/backups/alert.sh /usr/local/libexec/zephium-backups/
install -d -o root -g root -m 0700 /etc/zephium-backups /var/lib/zephium-backups
install -o root -g root -m 0600 deploy/backups/config.example /etc/zephium-backups/config
install -o root -g root -m 0644 deploy/backups/*.service deploy/backups/*.timer /etc/systemd/system/
```

Edit only the nonsecret `/etc/zephium-backups/config`. It is parsed as a strict allowlist of literal `KEY=value` lines, not executed as shell. All fields are required, even if the host environment has a matching variable. Duplicated/unknown keys, symlinks, wrong ownership/modes, malformed values and missing files fail closed. Keep parent directories root-owned and inaccessible to untrusted writers.

Set `COMPOSE_PROJECT_UUID` to the exact observed `com.docker.compose.project` label of the separate production Coolify resource. Do not use a display name, container name or staging UUID. Set both Compose service label values explicitly. Selection requires exactly one running container matching both project and service; zero or multiple matches fail. Verify the project label on the real deployment before using this template.

Set `HOST_DISK_PATH` to a directory on the filesystem actually holding the production PostgreSQL volume; confirm the mount/volume placement independently. The sample 4GiB WAL bound is a starting example requiring review against the intended disk/workload, not an observed production baseline. The monitor enforces at least15% available host filesystem capacity and WAL bytes no greater than that configured bound.

Verify the installed units and calendar expressions on the actual systemd version:

```sh
systemd-analyze verify /etc/systemd/system/zephium-backup@.service /etc/systemd/system/zephium-backup-alert@.service /etc/systemd/system/zephium-backup-monitor.service /etc/systemd/system/zephium-backup-full.timer /etc/systemd/system/zephium-backup-diff.timer /etc/systemd/system/zephium-backup-monitor.timer
systemd-analyze calendar 'Sun *-*-* 02:15:00 UTC' 'Mon..Sat *-*-* 02:15:00 UTC' '*-*-* *:00/15:00 UTC'
systemctl daemon-reload
```

No `enable` command is included: activation is a later production qualification step. Unit installation/reload does not start a timer. Before activation, run the full backup and monitor services deliberately against the qualified production resource, verify the worker alert reaches the destination, and complete the separate restore qualification. Start/enable timers only after that gate is explicitly satisfied.

## Behavior and limits

Full backup: Sunday02:15UTC. Differential: Monday–Saturday02:15UTC. Monitor: every15minutesUTC. Persistent timers catch up after downtime; delayed full/diff runs share one lock. Lock contention skips another backup, while lock/tool failures fail the service. The initial full backup must exist before differential scheduling begins.

Backups use repo1, the configured stanza and mandatory archive consistency checks. The container OS user is `postgres`. A 115minute in-container timeout terminates the pgBackRest process group; a slightly longer host timeout bounds Docker communication, and systemd supplies a final service deadline. No raw pgBackRest, Docker, psql, Python or notification output enters journald. Only generic success/failure messages are emitted. Detailed provider errors may contain credentials and must never be enabled in these host units.

The monitor reads up to1MiB of pgBackRest `info --output=json`, requires healthy stanza status and a successful (`error:false`) completed backup within30hours, rejects future completion timestamps, and checks one read-only scalar SQL result. Archival must be enabled with a successful archive timestamp and no later failed timestamp. It sums sizes from `pg_ls_waldir()` without emitting filenames or WAL contents. Commands and SQL have independent deadlines; malformed/missing metrics fail closed. This does not prove archive continuity or restorability and never deletes WAL.

OnFailure invokes `alert.sh` through the existing worker helper using event `backup_failed` or `backup_monitor_failed`. Alert attempts, including failed deliveries, are serialized and limited to one per event per hour using root-only state under `/var/lib/zephium-backups`. Missing config or a missing/ambiguous worker cannot deliver an alert; generic failure remains in journald. Notification service has no recursive OnFailure. Maintain an independent external uptime/dead-man check for a dead host, stopped timer or broken alert route.

## Local checks

```sh
bash -n deploy/backups/common.sh deploy/backups/backup.sh deploy/backups/monitor.sh deploy/backups/alert.sh
shellcheck -x -P deploy/backups deploy/backups/*.sh
python3 deploy/backups/test_backups.py
```

Fake commands test project/service isolation, absent/duplicate containers, root config validation, lock handling, deadline/error failure, backup freshness/WAL/archive/disk gates and notification cooldown. They mock GNU/root metadata behavior for portability; they do not qualify a real Docker daemon, root filesystem permissions, systemd installation, off-server repository, worker image or notification destination.

Reference contracts: [pgBackRest JSON info and archive-check](https://pgbackrest.org/command.html), [PostgreSQL archiver statistics](https://www.postgresql.org/docs/18/monitoring-stats.html#PG-STAT-ARCHIVER-VIEW), [WAL directory size function](https://www.postgresql.org/docs/18/functions-admin.html), [systemd calendar/persistent timers](https://www.freedesktop.org/software/systemd/man/260/systemd.timer.html).
