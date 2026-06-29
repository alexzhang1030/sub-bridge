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

- backend selection through `backend`
- Codex auth refresh and account extraction for `backend=codex`
- Cursor Agent ACP child process management for `backend=cursor-acp`
- model id normalization
- OpenAI Responses request normalization
- Pi wrapper forwarding
- SSE for `stream:true`
- JSON response for `stream:false`
- config file loading from `~/.config/sub-bridge/config.json`
- profile selection through `--profile <name>` or `SUB_BRIDGE_PROFILE`

## Targets

Targets own local app configuration.

| Target | Status | Responsibility |
| --- | --- | --- |
| `copilot` | supported | Write GitHub Copilot custom provider rows into `~/.copilot/data.db`. |
| `cursor` | planned | Add Cursor app provider configuration once its local provider storage format is mapped. |

Target adapters should write app-specific settings against the active profile's bridge base URL:

```text
http://127.0.0.1:17876/v1
```

## Backends

`backend=codex` routes requests to the ChatGPT/Codex subscription backend. `backend=cursor-acp` routes the same OpenAI Responses endpoint to Cursor Agent CLI:

```text
Copilot App -> http://127.0.0.1:17876/v1/responses -> sub-bridge -> agent acp
```

Cursor ACP settings:

```json
{
  "backend": "cursor-acp",
  "cursorAcpCommand": "/Users/alex/.local/bin/agent",
  "cursorWorkspace": "/absolute/path/to/project",
  "cursorModel": "default"
}
```

## Profiles

Profiles support multiple running bridge instances from one config file:

```text
Copilot App -> SubBridge        -> http://127.0.0.1:17876/v1 -> backend=cursor-acp
Copilot App -> SubBridge Codex  -> http://127.0.0.1:17877/v1 -> backend=codex
```

Each profile should define a unique `port`, `providerId`, and state directory. The default state directory becomes `~/.local/state/sub-bridge-cli/<profile>` when a profile is active.
