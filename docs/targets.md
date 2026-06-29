# Provider Targets

`sub-bridge-cli` separates the bridge runtime from app-specific provider setup.

## Runtime

The runtime serves OpenAI-compatible Responses routes:

```text
GET  /v1/models
POST /v1/responses
GET  /healthz
```

Runtime responsibilities:

- Codex auth refresh and account extraction
- model id normalization
- OpenAI Responses request normalization
- Pi wrapper forwarding
- SSE for `stream:true`
- JSON response for `stream:false`
- config file loading from `~/.config/sub-bridge/config.json`

## Targets

Targets own local app configuration.

| Target | Status | Responsibility |
| --- | --- | --- |
| `copilot` | supported | Write GitHub Copilot custom provider rows into `~/.copilot/data.db`. |
| `cursor` | planned | Add Cursor provider configuration once its local provider storage format is mapped. |

Target adapters should only write app-specific settings and should reuse the same bridge base URL:

```text
http://127.0.0.1:17876/v1
```
