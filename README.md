# Zephium backend

Accounts, billing, credits, and optional Cloud AI for Zephium. The desktop runs its agent loop and browser tools locally. This server authenticates accounts, forwards provider-native requests, and accounts for usage without storing prompts, pages, AI image/audio inputs, or generated output. Optional account avatars are retained separately as normalized profile images.

## Quick start

Use Bun 1.4.2 and PostgreSQL 18.4. Local development can use the included Docker database:

```sh
bun install --frozen-lockfile
cp .env.example .env
```

In `.env`, set separate random `AUTH_SECRET`, `ABUSE_SECRET`, and `ELIGIBILITY_SECRET` values of at least 32 characters. Then:

```sh
docker compose up -d postgres
bun run migrate
bun run cloud:register
bun run dev
```

Run `bun run worker` in another terminal. Real sign-in also needs your Resend key and verified sender in `.env`. Cloud AI starts disabled; tests use injected providers and need no live service credentials. Keep secrets in local private files or your deployment secret store, never in chat or Git.

For a deployment, start with the [staging setup walkthrough](docs/staging.md). It walks through the owner actions in GitHub, Resend, Polar, OpenAI, and Coolify. [Self-hosting](docs/self-hosting.md) is the separate option for your own model keys without Zephium billing.

## Code map

| Location | Responsibility |
| --- | --- |
| `src/apps/api` | HTTP application and API process |
| `src/apps/worker` | Background reconciliation and recovery process |
| `src/apps/admin`, `src/modules/admin` | Optional isolated read-only admin console and operator authentication |
| `src/modules/identity` | Email-code sign-in, sessions, account actions and enrollment |
| `src/modules/billing` | Polar products, checkout, subscriptions, refunds and reconciliation |
| `src/modules/credits` | Grants, reservations, settlement and spending exposure |
| `src/modules/ai` | Native provider requests, streaming, transcription and usage extraction |
| `src/modules/policy` | Versioned catalog, plans, pricing and spending limits |
| `src/platform` | Database and shared runtime infrastructure |
| `tests/support`, `tests/integration` | Shared fixtures and integration coverage |
| `config`, `migrations`, `deploy` | Reviewed policy, database changes and deployment files |

The API and worker are separate processes backed by PostgreSQL. Only the API has customer ingress; the optional admin console uses a separate restricted origin. Runtime processes check the active policy; operators explicitly register a reviewed revision during deployment.

## Documentation

- [Admin console](docs/admin.md): optional self-hosted user, usage and billing visibility with separate operator MFA and restricted database roles.
- [Architecture](docs/architecture.md): domain ownership and enforced dependency boundaries.
- [Staging setup](docs/staging.md): owner steps, configuration and first test.
- [Operations](docs/operations.md): updates, monitoring, backup and recovery.
- [Testing](docs/testing.md): runnable checks, recorded evidence and unverified deployment gates.
- [Desktop integration](docs/desktop-integration.md), [HTTP API](docs/api.md), [OpenAPI](docs/openapi.json): client contracts.
- [Cloud policy](docs/cloud-policy.md): catalog, allowances, pricing and budgets.

Run `bun run check` for module boundaries, TypeScript, formatting/lint and tests. Linux CI also executes the encrypted recovery and complete container-stack checks. Passing local checks does not establish live email, payment, model-provider, container or desktop readiness; the testing guide records those boundaries.

## License

[AGPL-3.0-only](LICENSE), except separately licensed components and data. Alternative commercial terms require a separate written agreement; see [commercial licensing](COMMERCIAL-LICENSING.md). A Cloud subscription does not change the source license. Set `SOURCE_URL` to the corresponding deployed release or fork; `/v1/source` exposes it.
