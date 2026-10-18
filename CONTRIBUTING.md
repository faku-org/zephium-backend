# Contributing

Report reproducible backend issues without credentials, email bodies, browsing content, or model prompts. Do not put suspected security vulnerabilities in public issues; use the repository's private vulnerability reporting once enabled.

Before submitting substantive code contributions, contact the maintainers to agree the applicable contribution terms. Zephium intends to offer public AGPL-3.0-only licensing and may separately offer commercial terms. This repository does not yet have a contributor agreement; maintainers must not assume they can relicense external contributions under commercial terms without appropriate rights. Do not merge third-party code without checking its provenance and license.

Backend changes must preserve the documented HTTP contract, avoid content logging/storage, include relevant trust-boundary tests, and pass `bun run check`. Configuration and deployment changes need explicit documentation of their verification limits.
