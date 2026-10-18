# Self-host Zephium backend

This is one Docker Compose topology for an operator-owned API, worker, and PostgreSQL 18.4 database. The repository has not deployed it. Self-hosting uses your domain, TLS proxy, email sender, model-provider keys, database, and backup account. It does not use Zephium billing, Zephium credentials, or purchased Zephium credits. The local cloud policy still uses integer credit units as an operator-controlled usage budget.

The repository's [LICENSE](../LICENSE) is AGPL-3.0. Any commercial license would be a separate agreement; this repository does not promise an enterprise edition or grant commercial terms.

## Topology and boundaries

[Compose file](../deploy/compose.self-host.yaml) runs PostgreSQL, a one-shot migrator, API, and worker. API and worker images run as the nonroot `bun` user with read-only root filesystems, bounded temporary files, process limits, and 45-second stop grace. The migration image uses a distinct database role. PostgreSQL has a persistent named volume and no host port; its application database network is internal, with a separate outbound network for encrypted S3-compatible archival. The worker has only the private database network and receives no auth, email, Polar, or model-provider keys. The API has outbound access for your Resend and model providers and is published only on host `127.0.0.1:3000` by default.

Place a TLS reverse proxy on the same host in front of that loopback port. Publish the HTTPS API origin through the proxy; do not expose container port 3000 or plaintext HTTP to the internet. Set `API_ORIGIN` and `TRUSTED_ORIGINS` to exact HTTPS origins. Set `TRUSTED_PROXY_CIDRS` only to the reverse proxy address or subnet that the API actually sees on the Docker bridge, after verifying it; do not trust all clients or an arbitrary public CIDR. The proxy should append the real client address to `X-Forwarded-For`. Verify both the observed peer and HTTPS routing before opening sign-up. For a custom desktop endpoint, store its session token in the OS vault under that exact origin and never reuse it for another Zephium origin or a direct provider call.

Default active limits are 1 GiB/1 CPU for API, 256 MiB/0.5 CPU for worker, and 2 GiB/1.5 CPU for PostgreSQL, plus a transient 256 MiB migrator. These leave headroom on the stated 4 vCPU/8 GiB host for the proxy, OS, and backup work. They are starting bounds, not throughput claims; tune from observed memory, WAL, and latency.

## Prepare images and private files

Use reviewed immutable image digests. The manual GitHub image workflow can build the `account` and `worker` targets off the VPS and reports their registry digests. The PostgreSQL image must be built from [deploy/postgres/Dockerfile](../deploy/postgres/Dockerfile) off the VPS and published to a registry you control; it adds pgBackRest and the existing archive command to `postgres:18.4-bookworm`. Set `ZEPHIUM_ACCOUNT_IMAGE`, `ZEPHIUM_WORKER_IMAGE`, and `ZEPHIUM_POSTGRES_IMAGE` to `registry/name@sha256:...` references. A local `docker build --target account`, `--target worker`, and `docker build -f deploy/postgres/Dockerfile` is suitable for development or an explicit operator build, but production's primary path builds on a trusted build machine and deploys exact digests.

Create a root-controlled directory outside Git, such as `/etc/zephium`, then generate an env file once:

```sh
umask 077
bun scripts/self-host-env.ts /etc/zephium/self-host.env
```

The generator refuses a path inside the repository or an existing file, writes mode `0600`, and prints only the destination path. Fill its blank image, policy, HTTPS origin, trusted proxy, sender, public corresponding-source URL, and Resend fields. `SOURCE_URL` must point to the deployed release or your modified source; `/v1/source` exposes this offer. It already contains independent random database-role, auth, abuse, and eligibility secrets plus separate migrator/app database URLs. Keep the file private; `docker compose config` without `--quiet` and privileged Docker inspection can expose interpolated environment values. Do not commit the file or paste its contents into a support request. Editing it does not rotate an already initialized PostgreSQL role password; rotate roles and connection URLs together under a maintenance procedure.

Copy [config/self-host.json](../config/self-host.json) to `/etc/zephium/self-host.json` and set `ZEPHIUM_POLICY_FILE` to that absolute path. Keep it readable by the container's `bun` user and free of credentials. The checked-in policy is disabled with zero allowances, so the first account can sign in while the catalog is empty. `SIGNUP_OPEN=true` allows that first account; set it to false after enrollment if this is a private instance. The self-host policy selects `selfHostedPlan` independently of Polar.

Use [deploy/postgres/pgbackrest.conf.example](../deploy/postgres/pgbackrest.conf.example) as the basis for a private `/etc/zephium/pgbackrest.conf`. Fill your own S3-compatible endpoint (the example uses Cloudflare R2), bucket-scoped key, and strong repository encryption passphrase; keep a separate recovery copy of the passphrase. Set `ZEPHIUM_PGBACKREST_CONFIG_FILE` to its absolute path. The file must be readable by the `postgres` user inside the pinned PostgreSQL image; determine that image's UID/GID, then set restrictive ownership and permissions on the host. The Compose file mounts it read-only. PostgreSQL uses the [archive settings](../deploy/postgres/postgresql.conf.example), which invoke `pgbackrest --stanza=zephium archive-push` directly. Do not consider backup active until the stanza, archive check, first full backup, and an independent restore have succeeded.

## First start

Run these from the repository checkout on the deployment host after the env and policy files are prepared. `config --quiet` validates interpolation without printing secrets:

```sh
docker compose --env-file /etc/zephium/self-host.env -f deploy/compose.self-host.yaml config --quiet
docker compose --env-file /etc/zephium/self-host.env -f deploy/compose.self-host.yaml up -d
```

The PostgreSQL initializer runs [roles.sql](../deploy/postgres/roles.sql) only for a fresh volume, sets generated role passwords, and makes `zephium_migrator` the database owner. The migrator applies schema changes and explicitly registers the mounted self-host policy before API and worker. API/worker startup only verifies the active revision and never activates a candidate; the application role receives DML privileges through PostgreSQL default grants and cannot own migrations. A reused volume does not rerun initialization. Never delete a volume to repair role or migration errors.

Once PostgreSQL is healthy, initialize and verify S3-compatible archival with the same Compose invocation:

```sh
docker compose --env-file /etc/zephium/self-host.env -f deploy/compose.self-host.yaml exec -u postgres postgres pgbackrest --stanza=zephium stanza-create
docker compose --env-file /etc/zephium/self-host.env -f deploy/compose.self-host.yaml exec -u postgres postgres pgbackrest --stanza=zephium check
docker compose --env-file /etc/zephium/self-host.env -f deploy/compose.self-host.yaml exec -u postgres postgres pgbackrest --stanza=zephium --type=full backup
```

Arrange scheduled full and differential backups and independent R2 restore drills using the [operations runbook](operations.md). Watch archive failures and local disk use; do not remove unarchived WAL to clear an alert.

Check Compose health, then verify `https://YOUR_API_ORIGIN/health/ready` and public `/v1/client-config` through the TLS proxy. The initial config should report `cloud_enabled:false`; a signed-in `GET /v1/models` should show no available models. Test a new email-code sign-in with your own Resend domain, confirm the client uses the exact custom origin, and verify only that origin receives its vault token. These are live checks for the operator to perform; they have not been run by this repository.

## Enable local model access and update safely

Keep `BILLING_ENABLED=false` and all Polar keys absent. To activate your own provider, review its actual model ID, limits, retention, and usage response; place your own key in the private env file's `CLOUD_*_KEY` field. Edit your mounted policy with a higher `revision`, your chosen self-host plan allowance and defaults, enabled model, and reviewed integer microcredit rates. Local credit units are a quota/accounting mechanism, not Zephium purchases or an assertion about provider prices. Validate before restart:

```sh
bun scripts/cloud-policy.ts validate /etc/zephium/self-host.json
```

Drain API requests and stop API/worker with their configured grace period, then rerun the migration/policy job and start them together against the reviewed policy:

```sh
docker compose --env-file /etc/zephium/self-host.env -f deploy/compose.self-host.yaml stop -t 45 api worker
docker compose --env-file /etc/zephium/self-host.env -f deploy/compose.self-host.yaml run --rm migrate
docker compose --env-file /etc/zephium/self-host.env -f deploy/compose.self-host.yaml up -d api worker
```

The one-shot migrator is the explicit self-host policy activation boundary; review its successful exit before resuming traffic. A previous revision cannot replace a newer active revision; to restore prior commercial values, publish a new revision. For image updates, pin reviewed digests, run the migrator first, then recreate API and worker. Keep database and policy backups before each change. Do not assume a green health check proves live provider compatibility or backup recovery.

This Compose file supplies one starting configuration. It does not create DNS, TLS certificates, a Resend domain, provider accounts, R2 storage, or an enterprise support arrangement.
