# Architecture

Zephium is a modular monolith: one codebase, one PostgreSQL database, and two runnable applications. The API accepts requests. The worker reconciles billing, exports usage and recovers interrupted work. Business modules are shared by these applications without importing either application.

## Ownership

| Module | Owns | Public consumers |
| --- | --- | --- |
| Identity | Sign-in, sessions, profiles, account lifecycle, email eligibility | API, billing, credits |
| Billing | Polar integration, checkout, subscriptions, webhook reconciliation | API, worker |
| Credits | Grants, holds, settlement, receipts, provider-cost exposure and budget admission | API, worker, AI, billing |
| AI | Provider-native protocols, streaming, transcription and usage extraction | API |
| Policy | Validated versioned plans, models, tariffs and explicit policy activation | API, worker, billing, credits, AI |

Each module has a deliberately exported `index.ts`, its own table declarations in `schema.ts`, and colocated `__tests__`. HTTP routes validate transport input and call domain operations. Business rules and transactions live in the module, not in the application router. Files are added for concrete responsibilities; modules do not need identical empty layers.

For example, identity separates sign-in integration (`auth.ts`, `routes.ts`), account commands (`account.ts`), authenticated account HTTP routes (`account-routes.ts`), session authorization (`session.ts`), action codes (`actions.ts`) and durable grant eligibility. Its public interface hides those implementation paths.

## Dependencies

`apps/api/app.ts` assembles routers, authentication and explicit cross-domain callbacks. `apps/api/middleware.ts` owns transport protections; `public-routes.ts` owns health, source and client configuration. `apps/worker/main.ts` owns scheduling and process shutdown.

`platform` supplies configuration, safe errors, abuse controls, body reading and database connections. It contains no plan or payment rules. Its one deliberate business reference is `platform/db/schema.ts`, an assembly of module schema exports for Drizzle tooling. Module schemas may reference another schema for declared foreign keys; business code still uses public module interfaces.

Declared business dependencies are acyclic:

```text
identity       policy
   ↑             ↑
   └── credits ──┘
         ↑
     billing / AI
```

Billing and AI also use public identity/policy contracts where needed. Identity does not import billing or credits. The application supplies lifecycle callbacks when account changes must coordinate with billing. Credits owns usage export and accepts a narrow ingestion callback, so it does not import Polar.

`bun run architecture` checks static runtime and type imports. It rejects undeclared/reversed dependencies, private cross-module imports, business imports from platform, and imports of application code from modules. It runs in the test suite and CI. It is a maintainability guard, not a substitute for review of SQL ownership or dynamic behavior. This applies the practical lesson of [Shopify's modularity work](https://shopify.engineering/enforcing-modularity-rails-apps-packwerk): folders alone do not enforce boundaries.

## Transactions and external work

Module boundaries do not imply separate transactions. Cross-domain operations that must commit together pass the same explicit PostgreSQL transaction to a narrow operation. Identity owns its eligibility/purge writes even when credits or billing coordinates the surrounding operation.

Credit admission deliberately reads identity, subscription and grant state together. These joins are part of the transactional entitlement projection, not a network call to another service. Preserve its documented lock order. Signup's Better Auth adapter is bound to the same transaction as signup admission and eligibility finalization. Account commands revalidate the persisted session after waiting for locks.

Checkout commits an intent before calling Polar, then finalizes in a short transaction. Durable jobs, idempotency and recovery handle lost responses. Some bounded reconciliation jobs still hold a selected row while calling a time-limited provider; do not mistake this for a general workflow framework or remove their crash-recovery ownership without replacing it.

Customer credits and provider-cost exposure are different ledgers. Refunding an uncertain customer charge does not erase possible provider spending. Global cost records survive account deletion. Provider payloads, audio, prompts, outputs, OTPs and raw IPs are excluded from durable billing/operational records.

## Testing and evolution

Domain tests live beside their owner. `tests/integration` covers complete HTTP/account/billing/generation and process boundaries. `tests/support` supplies disposable PostgreSQL and synthetic provider/policy fixtures. Tests are excluded from runtime images. SQL migrations remain authoritative and ordered; moving TypeScript table definitions does not rewrite migration history.

Future synchronization, organizations or cloud execution should be added as modules only when their behavior and data model are understood. Define ownership and the smallest public contract first, then add explicit dependencies and tests. End-to-end encrypted sync will require its own ciphertext/key-lifecycle design; this foundation does not implement it or store browser content today.

More machines are an operational decision. This layout supports independently moving API/worker processes and evolving module boundaries, but it does not prove capacity, high availability or live-provider compatibility. Those require staging evidence and production measurements.
