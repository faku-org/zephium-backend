# Test the backend

Use the pinned Bun 1.4.2 runtime. After installation, `node_modules/.bin/bun` avoids accidentally using a different global version. Integration tests start disposable PostgreSQL 18.4 and inject email, billing and model providers; ordinary test runs need no live API keys and make no real purchases or hosted model requests.

## Everyday checks

```sh
bun install --frozen-lockfile
bun run check
bun scripts/cloud-policy.ts validate config/cloud.json
bun scripts/cloud-policy.ts validate config/self-host.json
bun scripts/cloud-policy.ts validate config/staging.json
```

Run only the relevant tests while changing behavior, then the full check before release review. A name filter works across the integration suite:

```sh
bun test --test-name-pattern "refund" --timeout 60000
```

The checks cover identity/session boundaries, billing ownership and recovery, grants/reservations/settlement, native JSON/SSE/transcription, policy activation and spending controls. Keep fixtures under `tests/support` and integration behavior under `tests/integration`. See [desktop integration](desktop-integration.md) for the contract the native app must exercise.

## Database, proxy and container checks

| Check | Command | Requirement |
| --- | --- | --- |
| Native dump/drop/restore | `bun scripts/restore-check.ts` | Matching `pg_dump`/`pg_restore`; set `PG_TOOLS` to their directory if needed |
| Local HTTPS/SSE/privacy | `bun scripts/proxy-smoke.ts` | Local Traefik binary; set `TRAEFIK` when required |
| Encrypted pgBackRest/WAL restore | `bun scripts/container-check.ts` | Working Docker daemon |
| Self-host stack and private roles | `bun scripts/container-stack-check.ts` | Working Docker daemon |

The native restore check destroys its disposable source database before restoring a dump and comparing records. It also proves a restored refund cannot be resurrected by stale paid data and unknown provider exposure survives deletion of its originating account. Container scripts use disposable resources; neither proves that the real backup bucket, deployed secrets or Coolify routing work.

The GitHub **Check** workflow runs static checks, tests, policy validation and both container checks on Linux. **Build deployment images** depends on that workflow and publishes reviewed revision images only from `main`. Read the workflow result, not just the presence of a workflow file.

## Qualify the deployment separately

Use [staging setup](staging.md) for owner configuration and [operations](operations.md) for recovery. Record actual Resend delivery, Polar sandbox payment/refund behavior, native model metering, public TLS/SSE, independent encrypted restore and desktop flows. Green repository checks do not establish those results or a supported user capacity.

## Recorded evidence — 2026-10-18

The following records the completed modular refactor and identity hardening. It is local repository evidence, not a live-service qualification.

### Executed locally

- **153 tests passed, 0 failed, 1,055 assertions**, pinned Bun 1.4.2, across 21 files using disposable PostgreSQL 18.4, injected providers and real loopback HTTP. This includes all seven migrations, normal and interrupted billing/accounting, identity/eligibility, native streaming, multipart audio, deployment budgets, paid headroom, and restrictive runtime-role dispatch.
- Module dependency checks, strict TypeScript 7.0.2 and Biome pass. Hosted production and self-host policies validate disabled with zero commercial allowances. The separate staging policy validates with Luna lead/page/light, mini-transcribe for both plans and full transcribe Pro-only, with no real Polar product IDs.
- Native pg_dump/drop/pg_restore passes independently after destroying the source database. Restored accounts, billing, all migration digests, policies, grants/holds, outbox, checkout bindings, eligibility/aliases and actions match. Refund tombstones still reject stale paid observations after restoration. Global spend buckets and unknown provider exposure survive restoration even when the originating account/request was deleted before backup.
- Actual local Traefik 3.7.12 HTTPS/SSE privacy smoke passes: early streaming, expected bytes, no proxy compression/redirect/cookie injection, and no canary in proxy output. This does not verify Coolify's eventual generated route.
- Runtime dependency audit reports no known vulnerabilities across 31 packages. This is dependency evidence, not a guarantee of application security.
- Workflow/Compose YAML parsing and all 78 local OpenAPI references validate. Self-host migration+explicit-registration JavaScript was exercised against native disposable PostgreSQL. No load/capacity campaign was run.

Use `node_modules/.bin/bun` after installation if the global runtime differs. The workstation's global Bun 1.2.15 has different upload behavior; native voice deadline tests run on pinned 1.4.2. A voice test proves the overall deadline includes a 450 ms chunked upload, rather than starting after upload completion.

### Accounting and recovery coverage

| Historical finding | Implementation and regression evidence |
| --- | --- |
| Refund before grant forgotten | Durable billing_order_reversal; refund-before-paid, overlapping refresh and post-restore stale-payment rejection tests |
| Unconfirmed cancellation recycles allowance | Independent provider exposure survives customer refund/deletion; repeated unknown requests and customer daily exposure gate further admission; recovery and budget tests |
| Checkout exhausts its own pool | Durable intent commits before external I/O, final recording uses the same short transaction; four checkouts/four connections, deletion barrier and lost-response tests |
| One account blocks global admission | Account/provider waits precede short global admission lock; blocked account A does not delay account B regression |
| Failed startup activates policy | API/worker only assert active revision/digest; explicit migrator-only registration; actual failed candidate process leaves old deployment usable, with expected error asserted |

Additional fixes: keyed HMAC OTP storage, bounded awaited mail delivery and real cooldowns, exact staging email allowlist, one-time nonexpiring signup grant with alias/deletion preservation, local 429 Retry-After, export during billing review, UTC reservation-day accounting, positive provider-cost policy validation, and runtime policy-table write denial without breaking dispatch.

New identity regressions prove signup user/session/eligibility/IP admission share one PostgreSQL transaction, post-auth finalization failures roll back, invalid OTP attempts persist, and session revocation during a waiting email change prevents the mutation. The extracted HTTP routes retain their existing shapes. Module checks reject private/reversed imports and protect the new ownership boundaries.

### Voice and desktop coverage

See [desktop-integration.md](desktop-integration.md#release-contract-changes--2026-10-18) and [openapi.json](openapi.json). Notable compatibility change: usage.period_end is nullable for one-time allowance; use allowance.renews. Other additions include transcribe/default/audio prices and limits, funding_source, free subsidy/purchased availability, signup_mode, and typed voice/budget errors. No native desktop code was edited here.

Audio tests cover actual WAV structure and length, lower sample rates, malformed/unsupported/long audio, multipart limits/duplicates/language, native forwarding, auth/idempotency, success/silence, usage extraction, duration fallback, malformed usage, cancellation/timeouts, capped responses, shared concurrency/shutdown and catalog/plan controls. Customer duration fallback never fabricates tokens or releases unconfirmed provider-cost exposure.

### Not yet executed

The workstation still has no Docker runtime. The [first passing GitHub Check run](https://github.com/zephium-browser/backend/actions/runs/39121047189), for source 47b1b8f, independently passed on Linux: application tests, account/worker/PostgreSQL image builds, encrypted pgBackRest backup/WAL restoration, complete self-host Compose startup, private ports, runtime roles, nonroot/read-only containers, and health checks. This qualifies the repository container checks, not the real Coolify deployment or an off-server backup destination.

The public repository is https://github.com/zephium-browser/backend on main. Release-image publication and actual staging startup are separate from the passing Check run. [Staging runbook](staging.md), [environment inventory](../deploy/staging.env.example) and [hosted Compose](../deploy/compose.staging.yaml) provide the deployment handoff. Configure exact sandbox product IDs, staging keys, verified sender/quotas, approved test emails, immutable images, proxy trust, backup storage and alerts. The website agent must supply https://zephium.app/billing/return before Polar flows are qualified.

Live Resend delivery, Polar sandbox checkout/portal/webhooks/refunds, real provider outputs and metering, DNS/TLS, external monitoring and desktop end-to-end behavior remain unverified. Staging's $50 total/$10 daily limits include Pro test accounts; these limits and separate provider hard limits must be checked before spending. No live charges were made during this implementation.

OpenAI open_page/find_in_page search action pricing remains insufficiently explicit in the official guide; these ambiguous outputs retain unknown accounting/exposure rather than being assumed free. Qualify the enabled native-search combination in staging and resolve its billing contract before public activation. Anthropic beta headers remain unforwarded (desktop sends none); Jev is unused/disabled. The minimum client version remains advisory. Single-host availability and actual provider capacity remain deployment constraints.
