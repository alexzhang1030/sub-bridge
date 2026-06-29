# Provider Plugins

`sub-bridge` routes subscription-specific behavior through provider plugins in
`src/provider-plugins.js`.

Each plugin owns:

- config defaults: `id`, aliases, default sub names, port, provider id, provider name
- model discovery: `fetchModelSnapshot(ctx)`
- runtime forwarding: `forwardResponses(ctx, req, res, bodyText)`
- health reporting: `health(ctx)`
- status fields: `statusFields(ctx)`
- diagnostics: `doctor(ctx)`
- auth commands: `login(ctx)`, `logout(ctx)`

Current plugins:

| Plugin | Types | Runtime |
| --- | --- | --- |
| `cursor-acp` | `cursor-acp`, `cursor` | Cursor Agent ACP |
| `codex` | `codex` | Codex direct or Pi wrapper |

To add a provider, add a plugin object to `PROVIDER_PLUGINS`, implement the same
methods, and add tests for default resolution, offline model discovery, doctor,
and the runtime path it owns.
