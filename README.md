# sub-bridge-cli

Local OpenAI Responses bridge for subscription-backed coding agents.

The production target is GitHub Copilot custom providers. The bridge can route Copilot's OpenAI Responses requests to either the ChatGPT/Codex subscription backend or Cursor Agent CLI over ACP.

## Commands

```bash
sub-bridge --profile cursor status
sub-bridge status
sub-bridge login
sub-bridge logout
sub-bridge check
sub-bridge start
sub-bridge stop
sub-bridge models
sub-bridge config show
sub-bridge config init
sub-bridge config set backend cursor-acp
sub-bridge config set reasoningEffort xhigh
sub-bridge targets
sub-bridge install copilot
```

Compatibility alias:

```bash
sub-bridge install-copilot
```

## Configuration

Create a config file:

```bash
sub-bridge config init
```

Default path:

```text
~/.config/sub-bridge/config.json
```

Example:

```json
{
  "host": "127.0.0.1",
  "port": 17876,
  "model": "gpt-5.5",
  "backend": "codex",
  "reasoningEffort": "xhigh",
  "usePi": true,
  "piTransport": "auto",
  "stripTools": false,
  "cursorAcpCommand": "agent",
  "cursorWorkspace": "/absolute/path/to/project",
  "cursorModel": "default"
}
```

Useful commands:

```bash
sub-bridge config path
sub-bridge config show
sub-bridge --profile cursor config show
sub-bridge config set reasoningEffort max
sub-bridge --profile cursor config set backend cursor-acp
sub-bridge config unset reasoningEffort
```

## Profiles

Profiles let multiple bridge instances run at the same time from one config file. Each profile gets its own effective config, pid file, log file, port, and Copilot provider id.

```json
{
  "profiles": {
    "cursor": {
      "port": 17876,
      "backend": "cursor-acp",
      "providerId": "codexsub-openai-codex",
      "providerName": "SubBridge",
      "cursorAcpCommand": "/Users/alex/.local/bin/agent",
      "cursorWorkspace": "/absolute/path/to/project",
      "cursorModel": "default"
    },
    "codex": {
      "port": 17877,
      "backend": "codex",
      "providerId": "subbridge-codex",
      "providerName": "SubBridge Codex"
    }
  }
}
```

```bash
sub-bridge --profile cursor start
sub-bridge --profile codex start
sub-bridge --profile cursor install copilot
sub-bridge --profile codex install copilot
sub-bridge --profile cursor status
sub-bridge --profile codex status
```

## Environment Overrides

Environment variables override config file values. Use them for one-off runs and automation. Existing `CODEXSUB_*` and `GPT_SUB_BRIDGE_*` variables still work where they were already supported.

```bash
SUB_BRIDGE_CONFIG=~/.config/sub-bridge/config.json
SUB_BRIDGE_PROFILE=cursor
SUB_BRIDGE_HOST=127.0.0.1
SUB_BRIDGE_PORT=17876
SUB_BRIDGE_MODEL=gpt-5.5
SUB_BRIDGE_BACKEND=codex
SUB_BRIDGE_REASONING_EFFORT=xhigh
SUB_BRIDGE_USE_PI=1
SUB_BRIDGE_PI_TRANSPORT=auto
SUB_BRIDGE_STRIP_TOOLS=0
SUB_BRIDGE_CURSOR_ACP_COMMAND=agent
SUB_BRIDGE_CURSOR_WORKSPACE=/absolute/path/to/project
SUB_BRIDGE_CURSOR_MODEL=default
```

The provider endpoint is:

```text
http://127.0.0.1:17876/v1
```

## GitHub Copilot

Install or refresh the provider rows:

```bash
sub-bridge install copilot
```

Then start the local bridge:

```bash
sub-bridge start
sub-bridge check
```

The Copilot provider uses the OpenAI Responses wire API.

## Cursor

Cursor backend mode keeps the Copilot provider unchanged and swaps the bridge runtime behind `/v1/responses`.

```bash
sub-bridge config set backend cursor-acp
sub-bridge config set cursorAcpCommand /Users/alex/.local/bin/agent
sub-bridge config set cursorWorkspace /absolute/path/to/project
sub-bridge config set cursorModel default
sub-bridge start
```

The Cursor backend starts `agent acp`, initializes ACP, authenticates with `cursor_login`, creates a session with `session/new`, sends Copilot input via `session/prompt`, and converts `session/update` text chunks back to OpenAI Responses SSE.

Use `cursorModel=default` to let Cursor choose its configured model, or set a Cursor model id such as `sonnet-4-thinking`. Use `cursorModel=request` only when Copilot model ids match Cursor model ids.
