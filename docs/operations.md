# Operate the backend

Use [staging setup](staging.md) for the first hosted deployment or [self-hosting](self-hosting.md) for operator-owned model access without Zephium billing. This guide covers routine changes and recovery after setup.

## Before a deployment change

Keep the exact deployed source revision, image digests and policy revision together. Back up the database, private policy, eligibility secret and deployment configuration. Validate the candidate policy, environment and required provider keys before changing the active revision.

Close new traffic as appropriate, drain active requests, and stop API/worker with at least 45 seconds of grace. Apply migrations with the migrator role, explicitly register the reviewed policy, then start both runtime processes with application credentials and the matching policy file. The [staging command reference](staging.md#operator-command-reference) provides exact commands. Runtime startup never activates a policy candidate.

After starting, check public API readiness, worker health, sign-in, billing state and a bounded model request before reopening traffic. A failed candidate startup leaves the previously active policy unchanged. An explicit policy activation changes which runtime revision may admit work.

For rollback, select a compatible image and publish a higher policy revision restoring the intended values. Do not reduce the active revision, reverse migrations blindly or run old code against an incompatible schema.

## What to watch

| Signal | Operator action |
| --- | --- |
| API or worker unhealthy | Inspect aggregate errors, database connectivity and policy revision before restarting |
| Billing/order/export retries exhausted | Review the affected durable job and provider state; preserve idempotency |
| Missing usage or unexpected exposure | Compare provider usage and deployment budgets; investigate before raising limits |
| Email unavailable/throttled | Check Resend delivery/quota and retry guidance; never request or log a user's OTP |
| Backup stale, archive failing, disk pressure | Repair the archive path and preserve WAL; verify an independent restore |

Customer credits are charged from authoritative usage. Missing usage can release the customer's hold after recovery, while independent provider-cost exposure remains reserved and further admission is limited. Account deletion does not erase deployment spending. Do not edit balances, grants or `paid_until` directly as an incident shortcut, and do not automatically replay generation requests.

Use external uptime checks and a private `OPERATIONS_WEBHOOK` for alerts. Watch actual memory, database/WAL growth and latency before changing resource limits. Current limits and single-host deployment are not a capacity or availability guarantee.

## Back up and restore

Use a private [pgBackRest configuration](../deploy/postgres/pgbackrest.conf.example) with bucket-scoped storage credentials and repository encryption. Keep the encryption passphrase in separate recovery custody. The policy and backup configuration are read-only host mounts; ensure the intended container user can read them.

Initialize and check archival, then take a first full backup. For staging:

```sh
docker compose --env-file /etc/zephium-staging/staging.env -f deploy/compose.staging.yaml exec -u postgres postgres pgbackrest --stanza=zephium stanza-create
docker compose --env-file /etc/zephium-staging/staging.env -f deploy/compose.staging.yaml exec -u postgres postgres pgbackrest --stanza=zephium check
docker compose --env-file /etc/zephium-staging/staging.env -f deploy/compose.staging.yaml exec -u postgres postgres pgbackrest --stanza=zephium --type=full backup
```

Schedule weekly full and daily differential backups with WAL monitoring. Never delete unarchived WAL to clear an alert. Back up Coolify configuration, policy files, stable eligibility secret and other recovery credentials separately; a database volume backup does not contain them.

Restore to a new volume or host, keeping API/worker closed. Check accounts, sessions, billing jobs, refunds, grants/holds, policies, request recovery and deployment exposure. Reconcile Polar state and account/session revocations that occurred after the snapshot; rotate sessions before reopening after disaster recovery. Test the real encrypted off-host restore before calling backup ready.

The local [testing guide](testing.md) explains native and container restore checks. Those tests do not prove access to the deployed backup bucket or recovery passphrase.

## Protect the deployment boundary

Only API receives public HTTPS traffic; PostgreSQL and worker have no public ingress. Trust only the proxy addresses actually observed by API. Preserve the existing website's route. Disable proxy access logs, anonymous reporting and SSE compression using the reviewed [Traefik privacy arguments](../deploy/traefik-privacy-args.txt) and [route example](../deploy/traefik-api.yaml), adapted to the actual Coolify service/router names. Check the generated route for overlapping handlers. Test streaming, deadlines and shutdown through the deployed TLS path.

Keep staging and production secrets, databases, provider projects, Polar environments and backup paths separate. Enter secrets directly into the secret store, never chat or Git. Restrict SSH/Coolify access to operators and require MFA. PostgreSQL role initialization runs only for a fresh volume; existing passwords and roles need explicit maintenance. Never delete a volume to repair role or migration failures.

The API retains account, billing, policy, grant and usage records. It does not persist prompts, page text, output, images or audio. External email, billing and model providers have their own retention terms. Avoid logging request content, OTPs, credentials or raw identifiers during troubleshooting.

## Enrollment and email behavior

`SIGNUP_OPEN=false` stops new account creation; existing allowed users can still sign in. `SIGNUP_EMAIL_ALLOWLIST` restricts sign-in and email-change destinations to exact comma-separated addresses; an empty value permits all addresses. Case/whitespace are normalized, plus aliases remain distinct, and deletion remains available. Keep staging on an explicit list.

Email delivery is awaited and bounded by `EMAIL_MAX_IN_FLIGHT` (1–16). Delivery failure or saturation returns `503 email_unavailable` with retry guidance; provider throttling shares a cooldown across sign-in and account-action mail. There is no plaintext-code queue or automatic resend. Generic accepted responses also cover deliberately suppressed sends, so verify inbox receipt. Rotating `AUTH_SECRET` invalidates outstanding codes and sessions; preserve the independent eligibility secret unless carrying out a reviewed migration.

For client behavior, use the durable [desktop contract](desktop-integration.md). Public client config is cached for five minutes; server-side gates remain authoritative. Minimum client version is advisory.

The base hosted staging stack is deliberately disposable while off-server storage is pending. It disables archive_mode to prevent unarchived WAL accumulation. Apply compose.staging-backups.yaml only with working pgBackRest configuration and verify restoration before treating staging as backed up. This exception does not apply to production.
