# sub-bridge-cli

Local OpenAI Responses bridge for subscription-backed coding agents.

The current production target is GitHub Copilot custom providers. Cursor is modeled as a target slot so its adapter can be added without changing the bridge runtime.

## Commands

```bash
sub-bridge status
sub-bridge login
sub-bridge logout
sub-bridge check
sub-bridge start
sub-bridge stop
sub-bridge models
sub-bridge config show
sub-bridge config init
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
  "reasoningEffort": "xhigh",
  "usePi": true,
  "piTransport": "auto",
  "stripTools": false
}
```

Useful commands:

```bash
sub-bridge config path
sub-bridge config show
sub-bridge config set reasoningEffort max
sub-bridge config unset reasoningEffort
```

## Environment Overrides

Environment variables override config file values. Use them for one-off runs and automation. Existing `CODEXSUB_*` and `GPT_SUB_BRIDGE_*` variables still work where they were already supported.

```bash
SUB_BRIDGE_CONFIG=~/.config/sub-bridge/config.json
SUB_BRIDGE_HOST=127.0.0.1
SUB_BRIDGE_PORT=17876
SUB_BRIDGE_MODEL=gpt-5.5
SUB_BRIDGE_REASONING_EFFORT=xhigh
SUB_BRIDGE_USE_PI=1
SUB_BRIDGE_PI_TRANSPORT=auto
SUB_BRIDGE_STRIP_TOOLS=0
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

Cursor support belongs in the target registry as a separate install adapter. Keep the bridge runtime shared: `/v1/models`, `/v1/responses`, model normalization, auth refresh, Pi runtime, and stream handling should stay target-agnostic.
