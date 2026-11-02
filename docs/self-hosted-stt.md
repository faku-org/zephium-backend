# Self-hosted speech-to-text

Optional. Routes `/openai/v1/audio/transcriptions` to an operator-run OpenAI-compatible server instead of `api.openai.com`. Chat and token-count traffic is unaffected.

## Env (API container only)

| Variable | Meaning |
|---|---|
| `STT_ORIGIN` | Base origin of the server, e.g. `http://host.containers.internal:8894`. The gateway calls `{STT_ORIGIN}/v1/audio/transcriptions`. Plain `http://` is accepted: it is an operator-chosen private address. |
| `STT_KEY` | Optional bearer token sent to that server. |

With `STT_ORIGIN` set, `CLOUD_OPENAI_KEY` is not needed for dictation, and the startup provider-key check passes for a model whose only role is `transcribe`.

## Upstream contract

Multipart `file` (WAV), `model` (the policy `upstreamModel`), `response_format=json`, optional `language`. Response: `{"text": "..."}` plus the usage fields the gateway already reads from OpenAI.

## Policy

Declare the model in the mounted policy file (not the repo copy): `provider: "openai"`, `roles: ["transcribe"]`, explicit `rates.audioInput` and `rates.audioMinute` (and `costRates` if budgets are on), then `defaults.<plan>.transcribe` and a higher `revision`. Validate with `bun scripts/cloud-policy.ts validate <file>`.

## Verify

1. `curl` the STT server directly with a WAV and confirm `{"text": ...}`.
2. Signed-in `GET /v1/models` lists the transcriber; desktop Settings -> Voice shows the Zephium engine.
3. The STT server log shows the request; nothing leaves for `api.openai.com`.
