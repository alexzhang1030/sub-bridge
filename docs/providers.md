# Provider Plugins

`sub-bridge` routes subscription-specific behavior through provider plugins in
`src/provider-plugins.ts`.

Each plugin owns:

- config defaults: `id`, aliases, default sub names, port, provider id, provider name
- model discovery: `fetchModelSnapshot(ctx)`
- runtime forwarding: `forwardResponses(ctx, req, res, bodyText)` (Responses wire)
- health reporting: `health(ctx)`
- status fields: `statusFields(ctx)`
- diagnostics: `doctor(ctx)`
- auth commands: `login(ctx)`, `logout(ctx)`

The HTTP server also exposes **Chat Completions**
(`POST /v1/chat/completions`). That path is handled in `src/cli.ts`: chat
bodies are converted to Responses via `chatCompletionsBodyToResponsesBody`
(`src/app/wire/completions.ts`), then forwarded through the same runtime.
Cursor ACP has a dedicated streaming adapter; other backends use their
Responses forwarder.

Current plugins:

| Plugin | Types | Runtime | `/v1/responses` | `/v1/chat/completions` |
| --- | --- | --- | --- | --- |
| `cursor-acp` | `cursor-acp`, `cursor` | Cursor Agent ACP | yes | yes (native adapter + SSE) |
| `codex` | `codex` | Codex direct or Pi wrapper | yes | Copilot install sets this wire; prefer `/v1/responses` for direct clients |

Copilot registration (`install copilot`) sets `wireApi=completions` on the
provider row. Direct API clients may call `/v1/responses` without changing
Copilot settings.

To add a provider, add a plugin object to `PROVIDER_PLUGINS`, implement the same
methods, and add tests for default resolution, offline model discovery, doctor,
and the runtime path it owns.
