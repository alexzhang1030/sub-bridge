import type { ProviderPlugin, ProviderPluginContext } from "./types/provider";

function cleanType(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function cleanSub(value: unknown): string {
  return cleanType(value).replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function titleCase(value: unknown): string {
  return String(value || "")
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export const cursorAcpProviderPlugin: ProviderPlugin = {
  id: "cursor-acp",
  aliases: ["cursor"],
  defaultSubNames: ["cursor"],
  defaultPort: 17876,
  defaultProviderId: "subbridge-cursor",
  defaultProviderName: "SubBridge Cursor",
  matchesType(type) {
    return this.id === cleanType(type) || this.aliases.includes(cleanType(type));
  },
  matchesSubName(subName) {
    return this.defaultSubNames.includes(cleanSub(subName));
  },
  fetchModelSnapshot(ctx) {
    return ctx.fetchCursorModelSnapshot();
  },
  forwardResponses(ctx, req, res, bodyText) {
    return ctx.forwardResponsesCursorAcp(req, res, bodyText);
  },
  health(ctx) {
    const about = ctx.cursorAbout({
      command: ctx.cursorAcpCommand,
      env: ctx.makeCursorRuntimeEnv(),
      timeoutMs: 8000,
    });
    return {
      ok: true,
      provider: ctx.providerName,
      runtime: "cursor-acp",
      type: ctx.backend,
      default_model: ctx.defaultModel,
      cursor_command: ctx.cursorAcpCommand,
      cursor_workspace: ctx.cursorWorkspace,
      cursor_model: ctx.cursorModel,
      cursor: about,
    };
  },
  statusFields(ctx) {
    return { cursor_model: ctx.cursorModel };
  },
  doctor(ctx) {
    return {
      tools: {
        codex: ctx.commandProbe("codex", ["--version"]),
        cursorAgent: ctx.commandProbe(ctx.cursorAcpCommand, ["about", "--format", "json"], {
          env: ctx.makeCursorProbeEnv(),
        }),
      },
      auth: {
        cursor: {
          local: ctx.cursorAuthDoctor(),
          agent: ctx.cursorAbout({
            command: ctx.cursorAcpCommand,
            env: ctx.makeCursorRuntimeEnv(),
            timeoutMs: 8000,
          }),
        },
        codex: null,
      },
    };
  },
  login(ctx) {
    return ctx.loginCursor();
  },
  logout(ctx) {
    return ctx.logoutCursor();
  },
};

export const codexProviderPlugin: ProviderPlugin = {
  id: "codex",
  aliases: [],
  defaultSubNames: ["codex"],
  defaultPort: 17877,
  defaultProviderId: "subbridge-codex",
  defaultProviderName: "SubBridge Codex",
  matchesType(type) {
    return this.id === cleanType(type);
  },
  matchesSubName(subName) {
    return this.defaultSubNames.includes(cleanSub(subName));
  },
  fetchModelSnapshot(ctx) {
    return ctx.fetchCodexModelSnapshot();
  },
  forwardResponses(ctx, req, res, bodyText) {
    return ctx.usePiWrapper
      ? ctx.forwardResponsesPi(req, res, bodyText)
      : ctx.forwardResponsesRaw(req, res, bodyText);
  },
  async health(ctx) {
    const { accountId } = await ctx.loadCodexAuth();
    return {
      ok: true,
      provider: ctx.providerName,
      runtime: ctx.usePiWrapper ? "pi" : "direct",
      type: ctx.backend,
      pi_runtime_dir: ctx.usePiWrapper ? ctx.piRuntimeDir : null,
      pi_transport: ctx.usePiWrapper ? ctx.piTransport : null,
      default_model: ctx.defaultModel,
      account_id_present: Boolean(accountId),
    };
  },
  statusFields() {
    return { cursor_model: null };
  },
  doctor(ctx) {
    return {
      tools: {
        codex: ctx.commandProbe("codex", ["--version"]),
        cursorAgent: {
          command: ctx.cursorAcpCommand,
          checked: false,
          reason: "inactive-backend",
        },
      },
      auth: {
        cursor: null,
        codex: ctx.codexAuthDoctor(),
      },
    };
  },
  login(ctx) {
    return ctx.loginCodex();
  },
  logout(ctx) {
    return ctx.logoutCodex();
  },
};

export const PROVIDER_PLUGINS: ProviderPlugin[] = [
  cursorAcpProviderPlugin,
  codexProviderPlugin,
];

export function exactProviderPluginForType(type: string): ProviderPlugin | null {
  return PROVIDER_PLUGINS.find((plugin) => plugin.matchesType(type)) || null;
}

export function providerPluginForType(type: string): ProviderPlugin {
  return exactProviderPluginForType(type) || codexProviderPlugin;
}

export function defaultProviderTypeForSub(subName: string): string {
  return PROVIDER_PLUGINS.find((plugin) => plugin.matchesSubName(subName))?.id || codexProviderPlugin.id;
}

export function defaultProviderPort(subName: string, type: string): number {
  return exactProviderPluginForType(type)?.defaultPort || (cleanSub(subName) ? 17876 : cursorAcpProviderPlugin.defaultPort);
}

export function defaultProviderId(subName: string, type: string): string {
  const plugin = exactProviderPluginForType(type);
  if (plugin) return plugin.defaultProviderId;
  return `subbridge-${cleanSub(subName) || "default"}`;
}

export function defaultProviderName(subName: string, type: string): string {
  const plugin = exactProviderPluginForType(type);
  if (plugin) return plugin.defaultProviderName;
  return `SubBridge ${titleCase(cleanSub(subName) || "default")}`;
}

export type { ProviderPluginContext };
