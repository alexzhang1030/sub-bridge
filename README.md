# sub-bridge-cli

Local OpenAI **Responses** and **Chat Completions** bridge for GitHub Copilot
custom providers.

## Install

```bash
./install.sh
```

Installs `sub-bridge` to `~/.local/bin` and the bundled runtime to
`~/.local/lib/sub-bridge`, creates `cursor` and `codex` subscriptions,
fetches models, and writes Copilot provider rows when
`~/.copilot/data.db` exists.

```bash
./install.sh --start
./install.sh --launch-agent
./install.sh --no-copilot
```

## Uninstall

```bash
./uninstall.sh
./uninstall.sh --launch-agents
./uninstall.sh --remove-config --purge-data
```

Removes the command and runtime by default. Config and encrypted secrets
are kept unless you pass `--remove-config` or `--purge-data`.

## Subscriptions

`install.sh` creates two subscriptions by default:

| Sub | Type | Port | Copilot provider | Backend |
| --- | --- | --- | --- | --- |
| `cursor` | `cursor-acp` | `17876` | SubBridge Cursor | Cursor Agent ACP |
| `codex` | `codex` | `17877` | SubBridge Codex | ChatGPT/Codex OAuth |

Use `--sub` to target one subscription:

```bash
sub-bridge --sub cursor status
sub-bridge --sub codex status
sub-bridge --sub cursor serve
sub-bridge --sub codex serve
```

## Start

```bash
sub-bridge start
sub-bridge status
```

`start` without `--sub` starts every configured subscription.

```bash
sub-bridge --sub cursor check
sub-bridge --sub codex check
```

## Wire API

Each subscription listens on its own port and exposes **both** OpenAI wire
formats on the same base URL (`http://127.0.0.1:<port>/v1`):

| Wire API | Method | Path | Request shape | Response shape |
| --- | --- | --- | --- | --- |
| **Responses** | `POST` | `/v1/responses` | OpenAI Responses (`input`, `instructions`, …) | Responses object or SSE |
| **Chat Completions** | `POST` | `/v1/chat/completions` | OpenAI Chat (`messages`, …) | Chat completion object or SSE |

Shared routes on every subscription:

```text
GET  /v1/models
GET  /healthz
POST /v1/responses
POST /v1/chat/completions
```

`sub-bridge status` reports `wire_api: "completions+responses"` — the bridge
accepts either path. Chat Completions bodies are converted to Responses
internally before forwarding to Cursor ACP or Codex.

**Copilot:** `install copilot` registers providers with
`wireApi=completions` (Chat Completions). That matches Copilot’s native custom
provider path. Direct clients, scripts, and tools can call `/v1/responses`
instead without changing the running bridge.

Example (Responses):

```bash
curl -sS http://127.0.0.1:17876/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"auto","input":"Say hi","stream":false}'
```

Example (Chat Completions):

```bash
curl -sS http://127.0.0.1:17876/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"Say hi"}],"stream":false}'
```

Streaming works on both paths when `"stream": true`.

## Cursor Auth

```bash
SUB_BRIDGE_CURSOR_AUTH_TOKEN=... sub-bridge --sub cursor login
sub-bridge --sub cursor logout
```

The token is stored in the encrypted secrets vault at
`~/.local/state/sub-bridge-cli/cursor-auth/vault.enc`.

## Codex Auth

Codex uses the official `codex` CLI OAuth flow plus a client id for token
refresh.

```bash
# 1. Store OAuth client id (once)
sub-bridge secrets set codex_client_id '<your-client-id>'
# or: export SUB_BRIDGE_CODEX_CLIENT_ID=...

# 2. Log in with Codex CLI (writes ~/.codex/auth.json)
sub-bridge --sub codex login

# 3. Verify
sub-bridge --sub codex doctor
sub-bridge --sub codex check
```

Logout delegates to `codex logout`:

```bash
sub-bridge --sub codex logout
```

## Secrets

Shared encrypted vault (`sub-bridge secrets list|set|unset`):

| Secret | Used by | Env override |
| --- | --- | --- |
| `codex_client_id` | codex token refresh | `SUB_BRIDGE_CODEX_CLIENT_ID` |
| `cursor_auth_token` | cursor ACP | `SUB_BRIDGE_CURSOR_AUTH_TOKEN` |
| `bridge_key` | optional local API auth | `SUB_BRIDGE_KEY` |

## Config

Path:

```text
~/.config/sub-bridge/config.json
```

Shape:

```json
{
  "$schema": "https://raw.githubusercontent.com/alexzhang1030/sub-bridge/main/schemas/config.schema.json",
  "version": 1,
  "subscriptions": {
    "cursor": {
      "type": "cursor-acp",
      "host": "127.0.0.1",
      "port": 17876,
      "providerId": "subbridge-cursor",
      "providerName": "SubBridge Cursor",
      "models": [
        {
          "id": "claude-haiku-4-5",
          "displayName": "Haiku 4.5",
          "contextWindow": 128000,
          "maxTokens": 128000,
          "fastMode": false,
          "thinking": true,
          "reasoningEffort": "high",
          "cursorContextWindow": "1m"
        }
      ]
    },
    "codex": {
      "type": "codex",
      "host": "127.0.0.1",
      "port": 17877,
      "providerId": "subbridge-codex",
      "providerName": "SubBridge Codex",
      "models": [
        {
          "id": "gpt-5.5",
          "displayName": "SubBridge GPT-5.5",
          "contextWindow": 272000,
          "maxTokens": 128000
        }
      ]
    }
  }
}
```

### Cursor models and groups

Cursor model entries can set ACP options per model:

```json
{
  "reasoningEffort": "high",
  "fastMode": false,
  "thinking": true,
  "cursorContextWindow": "1m"
}
```

`config init` fetches Cursor models through ACP `cursor/list_available_models`
and keeps your per-model option overrides. Cursor model output follows the
Synara shape: rich base models first, then raw context/effort/fast variants.

Edit:

```bash
sub-bridge --sub cursor config init
sub-bridge --sub codex config init
```

Cursor model groups can be toggled by provider or family:

```bash
sub-bridge --sub cursor config groups
sub-bridge --sub cursor config group disable provider:anthropic
sub-bridge --sub cursor config group enable claude-opus-4-8
sub-bridge --sub cursor config group only claude-opus-4-8 gpt-5.5 composer-2.5 glm-5.2
sub-bridge --sub cursor config group preset latest
sub-bridge --sub cursor config group reset
```

Group filters affect `models`, serving, and Copilot registration.
The `latest` preset keeps a short Copilot menu: Opus 4.8, Opus 4.8 Fast,
Opus 4.8 Thinking, Opus 4.8 Thinking Fast, GPT-5.5, GPT-5.5 Fast,
Composer 2.5, Composer 2.5 Fast, and GLM 5.2.

### Codex models

Codex `config init` discovers models from the Codex CLI or falls back to
built-in defaults (`gpt-5.5`, `gpt-5.4`, etc.). No model-group filters —
edit the `models` array directly:

```bash
sub-bridge --sub codex config init
sub-bridge --sub codex models
sub-bridge --sub codex config set models '[{"id":"gpt-5.5"}]'
```

### Env overrides

Runtime overrides stay in env vars, for example:

```bash
# cursor
SUB_BRIDGE_CURSOR_ACP_COMMAND=/Users/alex/.local/bin/agent
SUB_BRIDGE_CURSOR_WORKSPACE=/absolute/project

# codex
SUB_BRIDGE_CODEX_CLIENT_ID=...
SUB_BRIDGE_AUTH_PATH=~/.codex/auth.json
SUB_BRIDGE_REASONING_EFFORT=xhigh
```

## Copilot

```bash
sub-bridge install copilot
```

Root install writes **both** subscriptions with `wireApi=completions`:

| Provider | Base URL | Copilot wire |
| --- | --- | --- |
| SubBridge Cursor | `http://127.0.0.1:17876/v1` | `completions` (`/v1/chat/completions`) |
| SubBridge Codex | `http://127.0.0.1:17877/v1` | `completions` (`/v1/chat/completions`) |

The bridge still serves `/v1/responses` on the same ports if you point a
client or manually set a provider’s `wire_api` to `responses` in
`~/.copilot/data.db`.

Install one subscription only:

```bash
sub-bridge --sub cursor install copilot
sub-bridge --sub codex install copilot
```

## Development

```bash
npm ci
npm run ci
```
