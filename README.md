# sub-bridge-cli

Local OpenAI Responses bridge for GitHub Copilot custom providers.

## Install

```bash
./install.sh
```

Installs `sub-bridge` to `~/.local/bin`, creates `cursor` and `codex`
subscriptions, fetches models, and writes Copilot provider rows when
`~/.copilot/data.db` exists.

```bash
./install.sh --start
./install.sh --launch-agent
./install.sh --no-copilot
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

## Cursor Auth

```bash
SUB_BRIDGE_CURSOR_AUTH_TOKEN=... sub-bridge --sub cursor login
```

The token is stored as encrypted local state at
`~/.local/state/sub-bridge-cli/cursor-auth/token.enc`.

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
      "providerId": "codexsub-openai-codex",
      "providerName": "SubBridge",
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
    }
  }
}
```

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
and keeps your per-model option overrides.

Edit:

```bash
sub-bridge --sub cursor config init
sub-bridge --sub codex config init
```

Runtime overrides stay in env vars, for example:

```bash
SUB_BRIDGE_CURSOR_ACP_COMMAND=/Users/alex/.local/bin/agent
SUB_BRIDGE_CURSOR_WORKSPACE=/absolute/project
```

## Copilot

```bash
sub-bridge install copilot
```

Root install writes all subscriptions. Sub install writes one subscription:

```bash
sub-bridge --sub cursor install copilot
```

## Development

```bash
npm ci
npm run ci
```
