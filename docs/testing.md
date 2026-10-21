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

## Recorded evidence — 2026-10-21

This is the current staging deployment record; the October 19 and October 18 sections below are historical. Application revision `36140fb084082c874686a495627271f32b8b5060` and policy revision **5** are live. Production remains unactivated.

- The preceding tax/credit rollout passed **296 tests / 1,704 assertions**, module boundaries, TypeScript and Biome. Both [Check](https://github.com/zephium-browser/backend/actions/runs/39611723108) and the [immutable image build](https://github.com/zephium-browser/backend/actions/runs/39611722086) passed for that exact source revision.
- Fresh global reconciliation confirmed zero outstanding purchased balances/holds, future checkout safety windows, pending billing/order jobs, active cloud requests and undelivered usage outbox records. Known legacy provider checkouts were no longer open; both refund-test orders remained refunded. No timestamps or balances were changed to bypass the migration gate.
- The pending deletion test completed naturally: account, billing, deletion and session rows were absent, and the external Polar customer was absent. This closes the October 19 final-purge gate.
- Policy 4 registered successfully at **2026-10-21 10:52:23 UTC**. After the API/worker rollout, both runtime policy files and the active database policy matched digest `4e88c7b40dd46fa5efd2b385ae419ea38c38ad4bddec2a1c5d224f4b62c61cc4`. Exact application images, healthy API/worker state and unchanged PostgreSQL image were verified.
- Independent public HTTPS checks returned readiness 200, the exact new source revision, expected cloud/billing/allowlisted-signup flags, and client-config conditional 304 with an empty body. Staging provider budgets remain USD50 total, USD10 per UTC day and USD5 daily free subsidy.
- The running application's billing, read-only usage and catalog projections returned `credit_units:"10000"`, the USD1/1,000,000-unit top-up, expected Pro/Max prices and an exact USD purchased balance. Existing grant count, amount, spent and held values were unchanged. This was a domain-level read using deployed code and provider products, not a new authenticated HTTP or checkout test. API/worker/migrator OCI revisions, migrator exit 0, restricted runtime settings and private network membership also passed.
- The new credit denomination and provisional allowances are documented in the [current desktop handoff](desktop-integration.md#staging-handoff--2026-10-21). Existing grants and historical request tariffs were preserved. Settlement regressions prove actual customer-tariff charging, separate provider-cost accounting, unused-hold release and duplicate-settlement safety.

- A subsequent rollout activated policy **5**, digest `df3993f02c043d205388ed15edb1f325ef1f4b501baa9c79301fae24ca1ad667`, with four additional packs. All prior allowances, tariffs, budgets and historical mappings were preserved. Live billing projections returned two subscriptions and five packs at the expected USD prices/units. The new packs were verified as nonarchived, nonrecurring products with one active fixed price each; no payment submissions were made during this configuration.
- The sandbox default tax behavior was changed to **Exclusive** and verified after reload. Existing price amounts were unchanged. The previously observed Polish USD20 order contained USD3.74 tax within its total; it was not a USD23.74 charge and was not modified.
- Minimum client version `1.0.0-beta.2` is explicitly passed into the API container and verified over public HTTPS. Upgrade previews now report unknown tax inclusion rather than the former hard-coded claim: `tax_excluded:null`, `tax_calculation:"not_calculated"`. HTTP regression coverage includes historical stored quotes. No approved-account quote remained for a fresh live receipt check, so the deployed view was additionally checked using synthetic in-memory input only, without inserting a quote or making a provider mutation.
- That tax/credit rollout's application images and OCI labels matched `c3c0641`; migration 0009 and the unchanged PostgreSQL image, healthy worker/API, policy file/database digest, private networks and restricted environment-file permissions passed verification.

### Avatar and transactional email rollout

- Revision `36140fb` passed **327 tests / 2,090 assertions**, module boundaries, TypeScript and Biome: [Check](https://github.com/zephium-browser/backend/actions/runs/39640410284), [immutable image build](https://github.com/zephium-browser/backend/actions/runs/39640417070). Coverage includes malformed/animated images, metadata stripping, byte/pixel limits, bounded processing, account isolation, revocation/deletion races, multipart HTTP limits and email templates.
- Exact API/worker image digests and OCI labels were verified after deployment. Migration `0010_account_avatars.sql`, all four runtime table privileges, healthy containers, restricted runtime settings and private networks passed. PostgreSQL, policy 5, allowances and budgets were unchanged. Native image processing passed inside the restricted deployed container.
- Authenticated public HTTPS testing passed: upload 200, re-encoded 256×256 WebP with stripped metadata, exact Content-Length and SHA-256 ETag, private cache policy, conditional 304, anonymous 401, exact exported image bytes, replacement with a new URL, superseded URL 404, deletion 200 and deleted URL 404. The synthetic image was removed, the test session revoked and local helper servers stopped. No purchases or account deletion were performed for these tests.
- A local destructive-source PostgreSQL restore rehearsal preserved exact normalized avatar bytes. The Linux container/restore checks also passed; this does not substitute for a production backup deployment.
- The owner received and redeemed a fresh sign-in email from the deployed template. Sign-in, email-change and deletion templates have HTML/plain-text coverage; local desktop/mobile visual inspection passed. Actual inbox visual appearance, light-mode rendering and Mail/Outlook autofill remain unconfirmed.
- Resend's sending domain and DNS verification passed. The current Free plan is limited to 100 emails/day and 3,000/month. Tracking flags could not be independently verified with the available token, and the DMARC TXT lookup returned NXDOMAIN. Before public signup, configure sufficient sending capacity, confirm tracking is disabled, establish DMARC and confirm the website privacy notice covers stored profile avatars and backup retention.

The final desktop credits/billing UI pass remains separate from these server checks. Actual monthly renewal is still future behavior with integration-test coverage. Production still needs final commercial configuration and its own deployment, operational backup/WAL restore, alerts and monitoring; this staging rollout does not qualify production.

## Recorded evidence — 2026-10-19

This historical record superseded the October 18 deployment statements. At the time, staging served application revision `781b7f3db9898e6c58b9e4777164cbe9bb76a75d`, migration 0009 and policy revision 3. Production has not been activated.

### Repository and deployment

- The complete local check passed **290 tests / 1,616 assertions**, module boundaries, TypeScript and Biome. The [release verification and immutable image build](https://github.com/zephium-browser/backend/actions/runs/39293804910) passed.
- A separate CI run exposed timing ambiguity in an existing real-HTTP test: its 600 ms overall budget could expire before the 150 ms idle timer after database admission. Test-only commit `71a2437` separates the deadlines without changing application behavior. All 11 gateway integration tests passed locally; the subsequent [complete CI run](https://github.com/zephium-browser/backend/actions/runs/39296436468) passed. Staging's application image remains `781b7f3`.
- The staging API and worker run the reviewed immutable digests. Public source metadata, readiness, policy revision/digest, migration 0009, worker freshness, private service networks and restricted environment-file permissions were checked. PostgreSQL was preserved during the guarded API/worker rollout.

### Live sandbox checks

These checks used approved disposable accounts, real email delivery, Polar sandbox and small synthetic OpenAI requests through the public HTTPS origin. They do not replace desktop UI testing.

| Boundary | Observed result |
| --- | --- |
| Identity | Email-code sign-in, account name, device/current session identity, export, verified email change with stable account ID, old-session revocation, and logout passed. Polar contact synchronization completed without retries. |
| Isolation and trial eligibility | Foreign usage and plan-change receipts returned 404. Reusing a previously claimed email did not issue another signup allowance. |
| AI and accounting | Native SSE completion trailer, idempotent replay rejection, text and voice receipts, plan gating, daily-cap rejection and zero-balance rejection passed. Purchased usage settled against the purchased pack with no remaining hold. |
| Checkout | A declined card granted no paid access. A successful purchase activated Pro without a manual billing refresh. Repeated creation was rate-limited, then blocked by the pending-checkout barrier. |
| Plan changes | Pro-to-Max applied once on the same subscription, preserving spent units and adding only the remaining-period allowance difference. Repeated confirmation returned the same operation. Max-to-Pro was scheduled for renewal without immediate loss of Max access. |
| Portal | Return URL was correct; cancellation set `cancelAtPeriodEnd:true` while retaining paid access and the same allowance. Conflicting plan changes were rejected. A customer with no Polar account received 409 `no_billing_account`. |
| Refunds | A full unused top-up refund revoked its grant without suspending the wallet; refresh did not resurrect it. Refunding a pack after spending six test units revoked the pack and produced 403 `billing_review_required`, while export and the portal remained available. Both order jobs and reversal records were verified. |
| Purchase restriction | Live testing found that a reviewed account could still create a checkout. Revision `781b7f3` fixes this; the same live request now returns 403. Six regressions cover checkout intents, upgrade preview/confirmation/dispatch, permitted downgrades and already-dispatched recovery. |
| Deletion | Code-confirmed deletion returned 202, disabled access immediately and removed sessions. The worker correctly retained the account until its checkout-safety barrier. Final provider deletion and local purge are still pending. |
| Client configuration | Billing/cloud are enabled only in staging, signup remains allowlisted, and conditional requests return an empty 304 with the expected ETag/cache behavior. |

The signed-event/worker integration produced the expected billing and refund state. Direct inspection/replay of Polar's webhook delivery history was not performed: the minimal runtime token lacks webhook-read access, and its secret-bearing dashboard panel was left unopened. Duplicate, delayed, refund-before-grant and interrupted-operation cases also have PostgreSQL integration-test coverage; do not describe all of them as live provider replay tests.

### Off-server recovery qualification

A separate rehearsal against the configured Hetzner Object Storage repository passed using synthetic data: encrypted full/differential backup, rejection of a wrong cipher password, deletion of the source database before restore, differential restore, post-backup WAL recovery, expiry, and restoration after expiry. Test containers/volumes were removed. This qualifies the storage/recovery mechanism, not a production database backup: production is not deployed, its backup timers are not enabled, and disposable staging still has archival disabled.

### Remaining gates

- Final deletion cleanup cannot run before **2026-10-20 16:35:39 UTC**; verify the actual provider cancellation/deletion and local purge after that boundary. Do not alter timestamps to manufacture a pass.
- Actual monthly renewal is in the future. Scheduling was verified live; renewal/grant transitions have clock-controlled integration tests.
- Run the desktop against this staging version, including plan changes, top-ups, review-state UI and return/refresh behavior.
- Confirm production allowances, credit denomination and provider invoice reconciliation; provision and qualify the separate production origin, credentials/products, actual initial backup/WAL restore, alerts, timers and independent monitoring. No production billing was enabled by these tests.

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

### CI and staging infrastructure

The workstation still has no Docker runtime. The [first passing GitHub Check run](https://github.com/zephium-browser/backend/actions/runs/39121047189), for source 47b1b8f, independently passed on Linux: application tests, account/worker/PostgreSQL image builds, encrypted pgBackRest backup/WAL restoration, complete self-host Compose startup, private ports, runtime roles, nonroot/read-only containers, and health checks. This qualifies the repository container checks, not the real Coolify deployment or an off-server backup destination.

The public repository is [zephium-browser/backend](https://github.com/zephium-browser/backend) on main. [Check](https://github.com/zephium-browser/backend/actions/runs/39121242488) and [image publication](https://github.com/zephium-browser/backend/actions/runs/39121242083) passed for the deployed source `046e6c8af032bf58af6b9dc1a4b3d7e2ed7b4df5`. Images remain private; the server successfully pulled all three immutable digests with read-only registry credentials.

Staging infrastructure was verified at `https://staging-api.zephium.app` on 2026-10-18:

- API, worker and PostgreSQL are healthy, with zero restarts after correcting a shared-network PostgreSQL DNS collision. API/worker run as `bun` with read-only roots; no service publishes a host port. The API shares a dedicated network with the proxy, while PostgreSQL and the worker remain private.
- Committed migrations applied and disabled policy revision 1 was explicitly registered. Generated service configuration retains separate runtime/migrator database roles and does not inject the complete environment into every container. The environment file is root-owned mode 0600 under a mode-0700 directory.
- Public HTTPS passed normal certificate verification. Liveness/readiness return 200. Client configuration reports signup, billing and Cloud AI disabled, with a strong ETag, 300-second cache policy and an empty 304 response on conditional requests. Unauthenticated account/catalog requests return 401; an unsigned Polar webhook returns 403 `invalid_signature`.
- The dedicated Traefik route disables access logging, tracing and metrics, uses immediate streaming flush, and leaves existing website routes untouched. Real authenticated SSE behavior still needs provider/desktop testing.
- The existing three Polar sandbox offers were retrieved successfully using the deployed token. These are test prices, not the newly selected production Pro/Max prices.
- The website's billing return page returns 200, does not render the test query marker, contains no analytics-domain reference, and serves no-referrer/noindex headers with a CSP excluding the analytics origin.

The subsequent plan-transition dispatch guard has separate local regression evidence: 24 credit tests passed, including rejection/release of an included Max hold after downgrade, continued eligibility of purchased credit on a shared model, rejection of Max-only access after downgrade, and settlement of an already-dispatched request. The complete local check then passed 157 tests with 1,069 assertions, module boundaries, TypeScript and lint. That change is not included in the deployed `046e6c8` image.

Live Resend delivery, Polar sandbox checkout/portal/webhooks/refunds, real provider outputs and metering, external monitoring, and desktop end-to-end behavior remain unverified. Staging's $50 total/$10 daily limits include paid test accounts; separate provider hard limits still need confirmation before spending. No live model charges were made during these infrastructure checks. Off-server backups remain explicitly deferred for disposable staging; CI restoration checks do not qualify an operational backup destination.

OpenAI open_page/find_in_page search action pricing remains insufficiently explicit in the official guide; these ambiguous outputs retain unknown accounting/exposure rather than being assumed free. Qualify the enabled native-search combination in staging and resolve its billing contract before public activation. Anthropic beta headers remain unforwarded (desktop sends none); Jev is unused/disabled. The minimum client version remains advisory. Single-host availability and actual provider capacity remain deployment constraints.
