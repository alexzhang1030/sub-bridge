import type { IncomingMessage, ServerResponse } from "node:http";

export interface CommandProbeResult {
  available: boolean;
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
}

export interface CommandProbeOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface ProviderPluginContext {
  backend: string;
  providerName: string;
  defaultModel: string;
  usePiWrapper: boolean;
  piRuntimeDir: string;
  piTransport: string;
  cursorAcpCommand: string;
  cursorWorkspace: string;
  cursorModel: string;
  commandProbe: (
    command: string,
    args?: string[],
    options?: CommandProbeOptions,
  ) => CommandProbeResult;
  makeCursorRuntimeEnv: () => NodeJS.ProcessEnv;
  makeCursorProbeEnv: () => NodeJS.ProcessEnv;
  cursorAbout: (options: { command: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Record<string, unknown>;
  cursorAuthDoctor: () => Record<string, unknown>;
  codexAuthDoctor: () => Record<string, unknown>;
  loadCodexAuth: () => Promise<{ accountId?: string }>;
  loginCursor: () => unknown;
  loginCodex: () => unknown;
  logoutCursor: () => unknown;
  logoutCodex: () => unknown;
  fetchCursorModelSnapshot: () => Promise<{ models?: unknown[]; source?: string; error?: string | null }>;
  fetchCodexModelSnapshot: () => Promise<{ models?: unknown[]; source?: string; error?: string | null }>;
  forwardResponsesCursorAcp: (
    req: IncomingMessage,
    res: ServerResponse,
    bodyText: string,
  ) => void | Promise<void>;
  forwardResponsesPi: (req: IncomingMessage, res: ServerResponse, bodyText: string) => void | Promise<void>;
  forwardResponsesRaw: (req: IncomingMessage, res: ServerResponse, bodyText: string) => void | Promise<void>;
}

export interface ProviderPlugin {
  id: string;
  aliases: string[];
  defaultSubNames: string[];
  defaultPort: number;
  defaultProviderId: string;
  defaultProviderName: string;
  matchesType: (type: string) => boolean;
  matchesSubName: (subName: string) => boolean;
  fetchModelSnapshot: (ctx: ProviderPluginContext) => Promise<{ models?: unknown[]; source?: string; error?: string | null }>;
  forwardResponses: (
    ctx: ProviderPluginContext,
    req: IncomingMessage,
    res: ServerResponse,
    bodyText: string,
  ) => void | Promise<void>;
  health: (ctx: ProviderPluginContext) => Record<string, unknown> | Promise<Record<string, unknown>>;
  statusFields: (ctx: ProviderPluginContext) => Record<string, unknown>;
  doctor: (ctx: ProviderPluginContext) => Record<string, unknown>;
  login: (ctx: ProviderPluginContext) => unknown;
  logout: (ctx: ProviderPluginContext) => unknown;
}
