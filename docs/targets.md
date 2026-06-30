# Provider Targets

`sub-bridge-cli` separates the bridge runtime from app-specific provider setup.

## Runtime

The runtime serves OpenAI-compatible **Responses** and **Chat Completions**
routes on the same `/v1` base URL:

```text
GET  /v1/models
POST /v1/responses
POST /v1/chat/completions
GET  /healthz
```

| Path | Wire API | Notes |
| --- | --- | --- |
| `/v1/responses` | Responses | Native bridge format (`input`, tool calls, SSE) |
| `/v1/chat/completions` | Chat Completions | Copilot default; converted to Responses before forwarding |

Runtime responsibilities:

- backend selection through subscription `type`
- Codex auth refresh and account extraction for `type=codex`
- Cursor Agent ACP child process management for `type=cursor-acp`
- model id normalization
- OpenAI Responses request normalization
- Chat Completions → Responses conversion (`src/app/wire/completions.ts`)
- Pi wrapper forwarding (Codex)
- SSE for `stream:true` (Copilot sync SSE)
- JSON response for `stream:false` (Copilot JSON client path)
- config file loading from `~/.config/sub-bridge/config.json`
- subscription selection through `--sub <name>` or `SUB_BRIDGE_SUB`

`sub-bridge status` reports `wire_api: "completions+responses"`.

## Targets

Targets own local app configuration.

| Target | Status | Responsibility |
| --- | --- | --- |
| `copilot` | supported | Write GitHub Copilot custom provider rows into `~/.copilot/data.db`. |
| `cursor` | planned | Add Cursor app provider configuration once its local provider storage format is mapped. |

Target adapters should write app-specific settings against the active subscription's bridge base URL:

```text
http://127.0.0.1:17876/v1
```

`install copilot` sets `wire_api=completions` and `settings_json.wireApi=completions`
so Copilot uses `/v1/chat/completions`. The Responses route remains available on
the same base URL.

## Backends

`type=codex` routes requests to the ChatGPT/Codex subscription backend.
`type=cursor-acp` routes to Cursor Agent CLI over ACP.

Responses path (both backends):

```text
Client -> http://127.0.0.1:17876/v1/responses -> sub-bridge -> agent acp | codex
```

Chat Completions path (Copilot default for Cursor):

```text
Copilot -> http://127.0.0.1:17876/v1/chat/completions -> sub-bridge -> agent acp
```

Cursor ACP settings:

```json
{
  "type": "cursor-acp",
  "cursorAcpCommand": "/Users/alex/.local/bin/agent",
  "cursorWorkspace": "/absolute/path/to/project",
  "cursorModel": "default"
}
```

## Subscriptions

Multiple bridge instances run from one config file:

```text
Copilot App -> SubBridge Cursor -> http://127.0.0.1:17876/v1 -> type=cursor-acp
Copilot App -> SubBridge Codex  -> http://127.0.0.1:17877/v1 -> type=codex
```

Each subscription should define a unique `port`, `providerId`, and state directory. The default state directory is `~/.local/state/sub-bridge-cli/<sub>` when `--sub` is set.
