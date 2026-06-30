import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AcpProcessorEvent } from "./types/acp";
import type { ConfigFile, SubscriptionConfig } from "./types/config";
import type { CursorModelEntry } from "./types/cursor";
import type { ProviderPluginContext } from "./types/provider";
import { isPlainObject } from "./lib/record";
import { Readable } from "node:stream";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform, release, arch } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { cursorAbout, fetchCursorAcpModels, makeCursorEnv, runCursorAcpTurn, shutdownCursorAcpRuntimes } from "./cursor-acp";
import { defaultCursorAcpCommand, makeCursorProbeEnv } from "./cursor-runtime";
import { errorMessage, isAbortLikeError, isRetryableTransientError } from "./errors";
import {
  defaultProviderId as defaultPluginProviderId,
  defaultProviderName as defaultPluginProviderName,
  defaultProviderPort,
  defaultProviderTypeForSub,
  providerPluginForType,
} from "./provider-plugins";
import {
  cursorOptionsFromModelEntry,
  filterCursorModelsByGroups,
  mergeCursorModelVariantsWithBaseControls,
  mergeCursorModelOptions,
  normalizeModelGroupsConfig,
  parseCursorCliModelList,
  resolveReasoningEffortForModel,
  summarizeCursorModelGroups,
  stripCursorParameterizedSuffix,
} from "./cursor-models";
import {
  beginResponsesSseStream,
  createSseRecorder,
  emitResponseInProgress,
  flushResponsesSseStream,
  normalizeResponseUsage,
  responseObject,
  sseDone,
} from "./app/wire/sse";
import {
  chatCompletionObject,
  chatCompletionsBodyToResponsesBody,
  chatMessageFromResponsesOutput,
  formatChatCompletionSseChunk,
} from "./app/wire/completions";
import {
  ensurePrivateDir,
  json,
  logPrefix,
  readJson,
  readRequestBody,
  requireBridgeAuth,
  writeJson,
} from "./app/lib/http";
import {
  loadCursorAuthToken as loadCursorAuthTokenFromVault,
  cursorAuthTokenPresent as cursorAuthTokenPresentInVault,
  removeCursorAuthToken as removeCursorAuthTokenFromVault,
  makeBridgeCursorEnv as buildBridgeCursorEnv,
  makeCursorRuntimeEnv as buildCursorRuntimeEnv,
} from "./app/auth/cursor-local";
import { loadCodexAuth as loadCodexAuthFromFile, decodeJwtPayload, extractAccountId } from "./app/auth/codex-oauth";
import { BUILTIN_MODELS, normalizeModelEntry, normalizeModelList, type ModelEntry } from "./app/models/registry";
import {
  normalizeModelId,
  normalizeRequestBody,
  requestUsesCopilotNativeStream,
} from "./app/wire/normalize";
import { normalizeToolCallIds } from "./app/wire/tool-ids";
import {
  allowedCopilotToolNames,
  appendCursorJsonOutputFromEvents,
  copilotNativeToolCallToFunctionCallItem,
  cursorExtensionPayloadToFunctionCallItem,
  cursorToolArguments,
  cursorToolCallToFunctionCallItem,
  cursorToolName,
  cursorToolStatusIsTerminal,
  extractCopilotToolCallsFromText,
  pushFunctionCallItem,
  resolveCursorAcpModel,
  stripCompanionAssistantMessagesWhenFunctionCalls,
} from "./app/wire/copilot-tools";

import {
  resolveCodexTokenUrl,
  resolveSecret,
  saveSecret,
  deleteSecret,
  listStoredSecrets,
  secretDoctorEntry,
  SecretName,
  type SecretNameValue,
} from "./secrets";

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_RESPONSES_PATH = "/codex/responses";

const CLI_NAME = "sub-bridge";
const CONFIG_VERSION = 1;
const CONFIG_SCHEMA_URL = "https://raw.githubusercontent.com/alexzhang1030/sub-bridge/main/schemas/config.schema.json";

type ResponseOutputItem = Record<string, unknown>;
type MessageContentPart = { type: string; text?: string; annotations?: unknown[] };
type ReasoningSummaryPart = { type: string; text?: string };
type PiStreamEvent = Record<string, unknown>;
type PiModelRecord = Record<string, unknown> & { id: string };
type PiRuntime = {
  provider: { stream: (...args: unknown[]) => AsyncIterable<PiStreamEvent> };
  models: Map<string, PiModelRecord>;
};
type PiOpenItem = {
  item: ResponseOutputItem;
  text?: string;
  args?: string;
  kind: string;
  outputIndex?: number;
};
type CursorStreamAssistantEntry = {
  item: ResponseOutputItem & { content: MessageContentPart[]; status?: string; id?: string };
  part: MessageContentPart;
  outputIndex: number;
  text: string;
};
type CursorStreamReasoningEntry = {
  item: ResponseOutputItem & { summary: ReasoningSummaryPart[]; status?: string; id?: string };
  part: ReasoningSummaryPart;
  outputIndex: number;
  text: string;
};
type CursorToolEntry = {
  toolCall: Record<string, unknown>;
  item: ResponseOutputItem;
  outputIndex: number;
  terminalReported: boolean;
};
type FetchJsonResult = {
  ok: boolean;
  status: number | null;
  body: unknown;
  error?: string;
};

type ConfigDocument = {
  $schema: string;
  version: number;
  subscriptions: Record<string, SubscriptionConfig>;
};

type CodexAuthFile = {
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
};

type CopilotDoctorDetails = {
  dbPath: string;
  exists: boolean;
  sqlite3: {
    available: boolean;
    ok: boolean;
    status: number | null;
    stdout: string;
    stderr: string;
    error: string | null;
  };
  providerId: string;
  extension: {
    name: string;
    dir: string;
    entry: string;
    exists: boolean;
  };
  provider: { id: string; name: string; baseUrl: string; wireApi: string } | null;
  modelCount: number | null;
  error: string | null;
};

function usageRecord(value: unknown): Record<string, number> | null | undefined {
  if (value == null) return value as null | undefined;
  return isPlainObject(value) ? (value as Record<string, number>) : null;
}

function configString(key: string, envKeys: string[], fallback: string): string {
  return configValue(key, envKeys, fallback) ?? fallback;
}

function piIndex(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value);
}

function piString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function piPayloadReasoningEffort(payload: Record<string, unknown>): string | null {
  const reasoning = payload.reasoning;
  if (!isPlainObject(reasoning)) return null;
  return typeof reasoning.effort === "string" ? reasoning.effort : null;
}

function bodyReasoningEffort(body: Record<string, unknown>, modelId: string): string {
  const reasoning = body.reasoning;
  if (isPlainObject(reasoning) && typeof reasoning.effort === "string") return reasoning.effort;
  return reasoningEffortForModel(modelId) ?? REASONING_EFFORT;
}

function bodyTextVerbosity(body: Record<string, unknown>): string {
  const text = body.text;
  if (isPlainObject(text) && typeof text.verbosity === "string") return text.verbosity;
  return "low";
}

function modelConfigForAcp(modelId: string): { cursorModel?: string } | null {
  const config = modelConfigFor(modelId);
  if (!config) return null;
  const cursorModel = (config as ModelEntry).cursorModel;
  return cursorModel !== undefined ? { cursorModel } : {};
}

function isSecretNameValue(name: string): name is SecretNameValue {
  return (Object.values(SecretName) as string[]).includes(name);
}

function piContentPart(item: ResponseOutputItem, index = 0): Record<string, unknown> | undefined {
  const content = item.content;
  if (!Array.isArray(content)) return undefined;
  const part = content[index];
  return isPlainObject(part) ? part : undefined;
}

function envValue(...keys: string[]): string | undefined {
  for (const key of keys) {
    if (process.env[key] !== undefined) return process.env[key];
  }
  return undefined;
}

function parseGlobalArgs(argv: string[]) {
  let sub = envValue("SUB_BRIDGE_SUB") || "";
  const args = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--sub") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      sub = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--sub=")) {
      sub = arg.slice("--sub=".length);
      continue;
    }
    args.push(arg);
  }
  return { sub: sub.trim(), args };
}

const GLOBAL_ARGS = parseGlobalArgs(process.argv.slice(2));
const SUB_NAME = GLOBAL_ARGS.sub;

function slug(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function subEnvKey(suffix: string): string {
  const name = slug(SUB_NAME).replace(/-/g, "_").toUpperCase();
  return name ? `SUB_BRIDGE_${name}_${suffix}` : "";
}

function envKeysForSub(suffix: string, fallbackKeys: string[] = []): string[] {
  return [subEnvKey(suffix), ...fallbackKeys].filter(Boolean);
}

const CODEX_TOKEN_URL = resolveCodexTokenUrl(
  envKeysForSub("CODEX_TOKEN_URL", ["SUB_BRIDGE_CODEX_TOKEN_URL", "CODEX_TOKEN_URL"]),
);

function defaultTypeForSub(subName: string): string {
  return defaultProviderTypeForSub(subName);
}

function defaultPortForSub(subName: string, type: string): number {
  return defaultProviderPort(subName, type);
}

function defaultProviderId(subName: string, type: string): string {
  return defaultPluginProviderId(subName, type);
}

function defaultProviderName(subName: string, type: string): string {
  return defaultPluginProviderName(subName, type);
}

const SUBSCRIPTION_CONFIG_KEYS = new Set([
  "type",
  "host",
  "port",
  "models",
  "modelGroups",
  "providerId",
  "providerName",
]);

const CONFIG_PATH =
  envValue("SUB_BRIDGE_CONFIG", "CODEXSUB_CONFIG") || join(homedir(), ".config", "sub-bridge", "config.json");

function readConfigFile(path: string = CONFIG_PATH): ConfigFile {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isPlainObject(parsed)) {
    throw new Error(`Config file must contain a JSON object: ${path}`);
  }
  return parsed;
}

const CONFIG_FILE = readConfigFile();

function normalizeSubscriptionConfig(subscription: unknown): SubscriptionConfig {
  const next: SubscriptionConfig = {};
  if (!isPlainObject(subscription)) return next;
  for (const key of SUBSCRIPTION_CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(subscription, key)) {
      (next as Record<string, unknown>)[key] = subscription[key];
    }
  }
  return next;
}

function subscriptionsFromConfig(configFile: ConfigFile): Record<string, SubscriptionConfig> {
  const source = isPlainObject(configFile?.subscriptions) ? configFile.subscriptions : {};
  const subscriptions: Record<string, SubscriptionConfig> = {};
  for (const [name, subscription] of Object.entries(source)) {
    if (!isPlainObject(subscription)) continue;
    subscriptions[name] = normalizeSubscriptionConfig(subscription);
  }
  return subscriptions;
}

function configDocument(subscriptions: Record<string, SubscriptionConfig> = subscriptionsFromConfig(CONFIG_FILE)) {
  return {
    $schema: CONFIG_SCHEMA_URL,
    version: CONFIG_VERSION,
    subscriptions,
  };
}

function activeConfig(configFile: ConfigFile, subName: string): SubscriptionConfig {
  if (!subName) return {};
  const subscription = subscriptionsFromConfig(configFile)[subName];
  return normalizeSubscriptionConfig(subscription);
}

const CONFIG = activeConfig(CONFIG_FILE, SUB_NAME);

function configValue(key: string, envKeys: string[], fallback?: string): string | undefined {
  const env = envValue(...envKeys);
  if (env !== undefined) return env;
  const configValueEntry = (CONFIG as Record<string, unknown>)[key];
  if (configValueEntry !== undefined) return String(configValueEntry);
  return fallback;
}

function configNumber(key: string, envKeys: string[], fallback: number): number {
  const value = configValue(key, envKeys, String(fallback));
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Invalid numeric config value for ${key}: ${value}`);
  return number;
}

function configBoolean(key: string, envKeys: string[], fallback: string): boolean {
  const value = configValue(key, envKeys, fallback);
  const normalized = String(value).toLowerCase();
  return !["0", "false", "no", "off"].includes(normalized);
}

const BACKEND = configString("type", envKeysForSub("TYPE", ["SUB_BRIDGE_TYPE"]), defaultTypeForSub(SUB_NAME));
const PROVIDER_PLUGIN = providerPluginForType(BACKEND);
const AUTH_PATH = configString(
  "authPath",
  envKeysForSub("AUTH_PATH", ["SUB_BRIDGE_AUTH_PATH", "CODEXSUB_AUTH_PATH"]),
  join(homedir(), ".codex", "auth.json"),
);
const COPILOT_DB = configString(
  "copilotDb",
  envKeysForSub("COPILOT_DB", ["SUB_BRIDGE_COPILOT_DB", "CODEXSUB_COPILOT_DB"]),
  join(homedir(), ".copilot", "data.db"),
);
const COPILOT_EXTENSION_NAME = "sub-bridge-tools";
const COPILOT_EXTENSION_DIR =
  envValue("SUB_BRIDGE_COPILOT_EXTENSION_DIR") ||
  join(homedir(), ".copilot", "extensions", COPILOT_EXTENSION_NAME);
const HOST = configString("host", envKeysForSub("HOST", ["SUB_BRIDGE_HOST", "CODEXSUB_HOST"]), "127.0.0.1");
const PORT = configNumber(
  "port",
  envKeysForSub("PORT", ["SUB_BRIDGE_PORT", "CODEXSUB_PORT"]),
  defaultPortForSub(SUB_NAME, BACKEND),
);
const DEFAULT_MODEL_OVERRIDE = envValue(...envKeysForSub("MODEL", ["SUB_BRIDGE_MODEL", "CODEXSUB_MODEL"]));
const ORIGINATOR = configString(
  "originator",
  envKeysForSub("ORIGINATOR", ["SUB_BRIDGE_ORIGINATOR", "CODEXSUB_ORIGINATOR"]),
  "pi",
);
const PROVIDER_ID = configString(
  "providerId",
  envKeysForSub("PROVIDER_ID", ["SUB_BRIDGE_PROVIDER_ID", "CODEXSUB_PROVIDER_ID"]),
  defaultProviderId(SUB_NAME, BACKEND),
);
const PROVIDER_NAME = configString(
  "providerName",
  envKeysForSub("PROVIDER_NAME", ["SUB_BRIDGE_PROVIDER_NAME", "CODEXSUB_PROVIDER_NAME"]),
  defaultProviderName(SUB_NAME, BACKEND),
);
const LEGACY_STATE_DIR = join(homedir(), ".local", "state", "gpt-sub-bridge");
const DEFAULT_STATE_DIR = join(homedir(), ".local", "state", "sub-bridge-cli");
const USE_LEGACY_STATE = existsSync(join(LEGACY_STATE_DIR, "gpt-sub-bridge.pid"));
const STATE_DIR = configString(
  "stateDir",
  envKeysForSub("STATE_DIR", ["SUB_BRIDGE_STATE_DIR", "CODEXSUB_STATE_DIR"]),
  SUB_NAME ? join(DEFAULT_STATE_DIR, slug(SUB_NAME)) : USE_LEGACY_STATE ? LEGACY_STATE_DIR : DEFAULT_STATE_DIR,
);
const PID_FILE_NAME = USE_LEGACY_STATE && STATE_DIR === LEGACY_STATE_DIR ? "gpt-sub-bridge.pid" : "sub-bridge.pid";
const LOG_FILE_NAME = USE_LEGACY_STATE && STATE_DIR === LEGACY_STATE_DIR ? "gpt-sub-bridge.log" : "sub-bridge.log";
const PID_PATH = configString(
  "pidPath",
  envKeysForSub("PID_PATH", ["SUB_BRIDGE_PID_PATH", "CODEXSUB_PID_PATH"]),
  join(STATE_DIR, PID_FILE_NAME),
);
const LOG_PATH = configString(
  "logPath",
  envKeysForSub("LOG_PATH", ["SUB_BRIDGE_LOG_PATH", "CODEXSUB_LOG_PATH"]),
  join(STATE_DIR, LOG_FILE_NAME),
);
const REASONING_EFFORT =
  envValue(...envKeysForSub("REASONING_EFFORT", [
    "SUB_BRIDGE_REASONING_EFFORT",
    "GPT_SUB_BRIDGE_REASONING_EFFORT",
    "CODEXSUB_REASONING_EFFORT",
  ])) || "xhigh";
const USE_PI_WRAPPER = configBoolean("usePi", ["SUB_BRIDGE_USE_PI", "GPT_SUB_BRIDGE_USE_PI", "CODEXSUB_USE_PI"], "1");
const LEGACY_PI_RUNTIME_DIR = join(homedir(), ".local", "share", "gpt-sub-bridge");
const PI_RUNTIME_DIR = configString(
  "piDir",
  ["SUB_BRIDGE_PI_DIR", "GPT_SUB_BRIDGE_PI_DIR"],
  existsSync(LEGACY_PI_RUNTIME_DIR) ? LEGACY_PI_RUNTIME_DIR : join(homedir(), ".local", "share", "sub-bridge-cli"),
);
const PI_TRANSPORT = configString("piTransport", ["SUB_BRIDGE_PI_TRANSPORT", "GPT_SUB_BRIDGE_PI_TRANSPORT"], "auto");
const PI_TIMEOUT_MS = configNumber("timeoutMs", ["SUB_BRIDGE_TIMEOUT_MS", "GPT_SUB_BRIDGE_TIMEOUT_MS"], 600000);
const STRIP_COPILOT_TOOLS = configBoolean(
  "stripTools",
  ["SUB_BRIDGE_STRIP_TOOLS", "GPT_SUB_BRIDGE_STRIP_TOOLS", "CODEXSUB_STRIP_TOOLS"],
  "0",
);
const SYNC_RESPONSES = configBoolean(
  "syncResponses",
  envKeysForSub("SYNC_RESPONSES", ["SUB_BRIDGE_SYNC_RESPONSES"]),
  "1",
);
const COPILOT_SSE_DATA_ONLY = configBoolean(
  "copilotSseDataOnly",
  envKeysForSub("COPILOT_SSE_DATA_ONLY", ["SUB_BRIDGE_COPILOT_SSE_DATA_ONLY"]),
  "1",
);
const BASE_URL = `http://${HOST}:${PORT}/v1`;
const HEALTH_URL = `http://${HOST}:${PORT}/healthz`;
const CURSOR_ACP_COMMAND = configString(
  "cursorAcpCommand",
  envKeysForSub("CURSOR_ACP_COMMAND", ["SUB_BRIDGE_CURSOR_ACP_COMMAND"]),
  defaultCursorAcpCommand(),
);
const CURSOR_API_ENDPOINT = configValue(
  "cursorApiEndpoint",
  envKeysForSub("CURSOR_API_ENDPOINT", ["SUB_BRIDGE_CURSOR_API_ENDPOINT"]),
  "",
);
const CURSOR_WORKSPACE = configString(
  "cursorWorkspace",
  envKeysForSub("CURSOR_WORKSPACE", ["SUB_BRIDGE_CURSOR_WORKSPACE"]),
  process.cwd(),
);
const CURSOR_MODEL = configString("cursorModel", envKeysForSub("CURSOR_MODEL", ["SUB_BRIDGE_CURSOR_MODEL"]), "request");
const CURSOR_ACP_TIMEOUT_MS = configNumber(
  "cursorAcpTimeoutMs",
  envKeysForSub("CURSOR_ACP_TIMEOUT_MS", ["SUB_BRIDGE_CURSOR_ACP_TIMEOUT_MS"]),
  600000,
);
const CURSOR_FORCE_CI = configBoolean("cursorForceCi", envKeysForSub("CURSOR_FORCE_CI", ["SUB_BRIDGE_CURSOR_FORCE_CI"]), "0");
const OFFLINE_DISCOVERY = configBoolean(
  "offlineDiscovery",
  envKeysForSub("OFFLINE", ["SUB_BRIDGE_OFFLINE", "SUB_BRIDGE_DISABLE_PROVIDER_DISCOVERY"]),
  "0",
);
const CURSOR_LOCAL_AUTH_DIR =
  envValue(...envKeysForSub("CURSOR_AUTH_DIR", ["SUB_BRIDGE_CURSOR_AUTH_DIR"])) ||
  join(DEFAULT_STATE_DIR, "cursor-auth");
const SECRETS_DIR =
  envValue(...envKeysForSub("SECRETS_DIR", ["SUB_BRIDGE_SECRETS_DIR"])) || CURSOR_LOCAL_AUTH_DIR;
const CURSOR_LOCAL_AUTH_KEY_PATH = join(CURSOR_LOCAL_AUTH_DIR, "key");
const CURSOR_LOCAL_AUTH_TOKEN_PATH = join(CURSOR_LOCAL_AUTH_DIR, "token.enc");
const BRIDGE_KEY = resolveSecret(
  SECRETS_DIR,
  SecretName.BRIDGE_KEY,
  envKeysForSub("KEY", ["SUB_BRIDGE_KEY", "CODEXSUB_BRIDGE_KEY"]),
).value;
let piRuntimePromise: Promise<PiRuntime> | null = null;

function logLine(message: string, fields: Record<string, unknown> = {}): void {
  const suffix = Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
  console.log(`${new Date().toISOString()} ${message}${suffix}`);
}

function activeModels() {
  const configured = normalizeModelList(CONFIG.models);
  const models = configured.length > 0 ? configured : BUILTIN_MODELS;
  const expanded = PROVIDER_PLUGIN.id === "cursor-acp"
    ? mergeCursorModelVariantsWithBaseControls(models)
    : models;
  return PROVIDER_PLUGIN.id === "cursor-acp"
    ? filterCursorModelsByGroups(expanded, CONFIG.modelGroups)
    : expanded;
}

const MODELS = activeModels();

function defaultModelFromModels() {
  const override = String(DEFAULT_MODEL_OVERRIDE || "").trim();
  if (override) {
    let value = override;
    if (value.includes("#")) value = value.slice(value.lastIndexOf("#") + 1);
    if (value.includes("/")) value = value.slice(value.lastIndexOf("/") + 1);
    if (value.startsWith("codexsub:")) value = value.slice("codexsub:".length);
    return value || MODELS[0]?.id || BUILTIN_MODELS[0].id;
  }
  return MODELS[0]?.id || BUILTIN_MODELS[0].id;
}

const DEFAULT_MODEL = defaultModelFromModels();

function modelConfigFor(modelId: string) {
  const normalized = normalizeModelId(modelId, DEFAULT_MODEL);
  const base = stripCursorParameterizedSuffix(normalized);
  return (
    MODELS.find((model) => model.id === normalized) ||
    MODELS.find((model) => stripCursorParameterizedSuffix(model.id) === base) ||
    null
  );
}

function reasoningEffortForModel(modelId: string) {
  return resolveReasoningEffortForModel(modelConfigFor(modelId), REASONING_EFFORT);
}

function cursorOptionsForModel(modelId: string, body: Record<string, unknown>) {
  const modelConfig = modelConfigFor(modelId);
  const effort = reasoningEffortForModel(modelId);
  const resolvedReasoning = effort ? { reasoningEffort: effort } : null;
  return mergeCursorModelOptions(cursorOptionsFromModelEntry(modelConfig), resolvedReasoning);
}

function acpModelOptions(modelId: string, body: Record<string, unknown>): Record<string, unknown> | undefined {
  const options = cursorOptionsForModel(modelId, body);
  return options ? { ...options } : undefined;
}

function requestModelFromBody(body: Record<string, unknown>): string {
  return typeof body.model === "string" ? body.model : DEFAULT_MODEL;
}

function usage(exitCode = 0) {
  console.log(`Usage:
  ${CLI_NAME} --sub <name> status
  ${CLI_NAME} status
  ${CLI_NAME} login
  ${CLI_NAME} logout
  ${CLI_NAME} check
  ${CLI_NAME} doctor
  ${CLI_NAME} enable
  ${CLI_NAME} start
  ${CLI_NAME} stop
  ${CLI_NAME} models
  ${CLI_NAME} config show
  ${CLI_NAME} config init
  ${CLI_NAME} config set <key> <value>
  ${CLI_NAME} config groups
  ${CLI_NAME} config group <enable|disable> <group>
  ${CLI_NAME} config group only <group...>
  ${CLI_NAME} config group preset <latest|off>
  ${CLI_NAME} config group reset
  ${CLI_NAME} targets
  ${CLI_NAME} install copilot

  sub-bridge secrets list
  sub-bridge secrets set <name> <value>
  sub-bridge secrets unset <name>

Aliases:
  serve = start
  probe = check
  install-copilot = install copilot

Environment:
  SUB_BRIDGE_CONFIG=${CONFIG_PATH}
  SUB_BRIDGE_SUB=${SUB_NAME || "optional-sub"}
  SUB_BRIDGE_<SUB>_PORT=17876
  SUB_BRIDGE_<SUB>_HOST=127.0.0.1
  SUB_BRIDGE_MODEL=gpt-5.5
  SUB_BRIDGE_TYPE=codex|cursor-acp
  SUB_BRIDGE_KEY=optional-local-key
  SUB_BRIDGE_CODEX_CLIENT_ID=required-for-codex-token-refresh
  SUB_BRIDGE_CODEX_TOKEN_URL=https://auth.openai.com/oauth/token
  SUB_BRIDGE_SECRETS_DIR=${SECRETS_DIR}
  SUB_BRIDGE_REASONING_EFFORT=xhigh
  SUB_BRIDGE_CURSOR_ACP_COMMAND=${CURSOR_ACP_COMMAND}
  SUB_BRIDGE_CURSOR_WORKSPACE=${CURSOR_WORKSPACE}
  SUB_BRIDGE_CURSOR_MODEL=request
  SUB_BRIDGE_CURSOR_AUTH_TOKEN=cursor-token
`);
  process.exit(exitCode);
}

function codexClientId() {
  return resolveSecret(
    SECRETS_DIR,
    SecretName.CODEX_CLIENT_ID,
    envKeysForSub("CODEX_CLIENT_ID", ["SUB_BRIDGE_CODEX_CLIENT_ID", "CODEX_CLIENT_ID"]),
    { required: true },
  ).value;
}

const cursorAuthEnvKeys = () =>
  envKeysForSub("CURSOR_AUTH_TOKEN", ["SUB_BRIDGE_CURSOR_AUTH_TOKEN", "CURSOR_AUTH_TOKEN"]);

function loadCursorAuthToken() {
  return loadCursorAuthTokenFromVault(SECRETS_DIR, cursorAuthEnvKeys());
}

function cursorAuthTokenPresent() {
  return cursorAuthTokenPresentInVault(SECRETS_DIR, cursorAuthEnvKeys());
}

function removeCursorAuthToken() {
  removeCursorAuthTokenFromVault(SECRETS_DIR);
}

function makeBridgeCursorEnv({ includeToken = true, forceCi = CURSOR_FORCE_CI } = {}) {
  return buildBridgeCursorEnv({
    secretsDir: SECRETS_DIR,
    cursorLocalAuthDir: CURSOR_LOCAL_AUTH_DIR,
    cursorForceCi: forceCi,
    envKeys: cursorAuthEnvKeys(),
    includeToken,
    makeCursorEnv,
  });
}

function makeCursorRuntimeEnv({ forceCi = CURSOR_FORCE_CI } = {}) {
  return buildCursorRuntimeEnv({
    secretsDir: SECRETS_DIR,
    cursorLocalAuthDir: CURSOR_LOCAL_AUTH_DIR,
    cursorForceCi: forceCi,
    envKeys: cursorAuthEnvKeys(),
    makeCursorEnv,
  });
}

async function loadCodexAuth({ forceRefresh = false } = {}) {
  return loadCodexAuthFromFile(() => readJson(AUTH_PATH), {
    authPath: AUTH_PATH,
    tokenUrl: CODEX_TOKEN_URL,
    clientId: codexClientId(),
    forceRefresh,
  });
}

function normalizeRequestBodyForBridge(
  bodyText: string,
  { stripTools = STRIP_COPILOT_TOOLS, req = null }: { stripTools?: boolean; req?: IncomingMessage | null } = {},
) {
  return normalizeRequestBody(bodyText, {
    stripTools,
    req,
    defaultModel: DEFAULT_MODEL,
    reasoningEffortForModel,
  });
}

async function loadPiRuntime(): Promise<PiRuntime> {
  if (!piRuntimePromise) {
    piRuntimePromise = (async () => {
      const providerPath = join(
        PI_RUNTIME_DIR,
        "node_modules",
        "@earendil-works",
        "pi-ai",
        "dist",
        "providers",
        "openai-codex.js",
      );
      const mod = (await import(pathToFileURL(providerPath).href)) as {
        openaiCodexProvider: () => PiRuntime["provider"] & { getModels: () => PiModelRecord[] };
      };
      const provider = mod.openaiCodexProvider();
      const models = new Map(provider.getModels().map((model) => [model.id, model]));
      return { provider, models };
    })();
  }
  return piRuntimePromise;
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (isPlainObject(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function textFromResponsesContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    const entry = item as Record<string, unknown>;
    if (typeof item === "string") {
      parts.push(item);
    } else if (entry?.type === "input_text" || entry?.type === "output_text" || entry?.type === "text") {
      if (typeof entry.text === "string") parts.push(entry.text);
    } else if (entry?.type === "refusal" && typeof entry.refusal === "string") {
      parts.push(entry.refusal);
    }
  }
  return parts.join("");
}

function imageFromResponsesPart(part: unknown): { type: "image"; mimeType: string; data: string } | null {
  const record = isPlainObject(part) ? part : null;
  if (!record || record.type !== "input_image") return null;
  const imageUrlRecord = isPlainObject(record.image_url) ? record.image_url : null;
  const imageUrl = imageUrlRecord?.url ?? record.image_url;
  if (typeof imageUrl !== "string") return null;
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(imageUrl);
  if (!match) return null;
  return { type: "image", mimeType: match[1], data: match[2] };
}

function userContentFromResponsesContent(content: unknown): string | Array<{ type: string; text?: string; mimeType?: string; data?: string }> {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const blocks: Array<{ type: string; text?: string; mimeType?: string; data?: string }> = [];
  for (const item of content) {
    if (typeof item === "string") {
      blocks.push({ type: "text", text: item });
      continue;
    }
    const image = imageFromResponsesPart(item);
    if (image) {
      blocks.push(image);
    } else if (isPlainObject(item)) {
      if (item.type === "input_text" || item.type === "text") {
        if (typeof item.text === "string") blocks.push({ type: "text", text: item.text });
      }
    }
  }
  if (blocks.length === 0) return "";
  if (blocks.every((block) => block.type === "text")) {
    return blocks.map((block) => block.text ?? "").join("");
  }
  return blocks;
}

function convertResponsesToolsToPi(tools: unknown) {
  if (!Array.isArray(tools)) return [];
  const converted: Array<{ name: string; description: string; parameters: Record<string, unknown> }> = [];
  for (const tool of tools) {
    const toolRecord = isPlainObject(tool) ? tool : null;
    const source = isPlainObject(toolRecord?.function) ? toolRecord.function : toolRecord;
    const name = source?.name;
    if (toolRecord?.type && toolRecord.type !== "function") continue;
    if (typeof name !== "string" || !name) continue;
    converted.push({
      name,
      description: typeof source.description === "string" ? source.description : "",
      parameters: isPlainObject(source?.parameters)
        ? source.parameters
        : { type: "object", properties: {}, additionalProperties: false },
    });
  }
  return converted;
}

function responsesBodyToPiContext(body: Record<string, unknown>) {
  const model = normalizeModelId(String(body.model ?? ""), DEFAULT_MODEL);
  const messages: Array<Record<string, unknown>> = [];
  const systemParts: string[] = [];
  const toolNamesByCallId = new Map<string, string>();

  if (typeof body.instructions === "string" && body.instructions) {
    systemParts.push(body.instructions);
  }

  const input = typeof body.input === "string" ? [{ role: "user", content: body.input }] : body.input;
  for (const item of Array.isArray(input) ? input : []) {
    if (!isPlainObject(item)) continue;

    const role = item.role;
    const type = item.type;
    if (role === "system" || role === "developer") {
      const text = textFromResponsesContent(item.content);
      if (text) systemParts.push(text);
      continue;
    }

    if (role === "user" || type === "input_message") {
      messages.push({
        role: "user",
        content: userContentFromResponsesContent(item.content),
        timestamp: Date.now(),
      });
      continue;
    }

    if (role === "assistant" || type === "message") {
      const text = textFromResponsesContent(item.content);
      if (!text) continue;
      messages.push({
        role: "assistant",
        content: [{ type: "text", text }],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model,
        usage: emptyUsage(),
        stopReason: "stop",
        timestamp: Date.now(),
      });
      continue;
    }

    if (type === "function_call") {
      const ids = normalizeToolCallIds(item);
      const name = String(item.name || "tool");
      toolNamesByCallId.set(ids.callId, name);
      messages.push({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: ids.combinedId,
            name,
            arguments: parseJsonObject(item.arguments),
          },
        ],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model,
        usage: emptyUsage(),
        stopReason: "toolUse",
        timestamp: Date.now(),
      });
      continue;
    }

    if (type === "function_call_output") {
      const callId = String(item.call_id || "");
      const output = textFromResponsesContent(item.output ?? item.content);
      messages.push({
        role: "toolResult",
        toolCallId: callId,
        toolName: toolNamesByCallId.get(callId) || "tool",
        content: [{ type: "text", text: output }],
        isError: Boolean(item.is_error),
        timestamp: Date.now(),
      });
    }
  }

  const tools = convertResponsesToolsToPi(body.tools);
  return {
    context: {
      systemPrompt: systemParts.join("\n\n") || "You are a helpful coding assistant.",
      messages,
      tools: tools.length > 0 ? tools : undefined,
    },
    toolsOut: tools.length,
  };
}

async function collectPiResponse({
  provider,
  model,
  context,
  token,
  sessionId,
  body,
  signal,
}: {
  provider: { stream: (...args: unknown[]) => AsyncIterable<Record<string, unknown>> };
  model: { id: string };
  context: Record<string, unknown>;
  token: string;
  sessionId: string;
  body: Record<string, unknown>;
  signal: AbortSignal;
}) {
  const output: ResponseOutputItem[] = [];
  const openItems = new Map<number, PiOpenItem>();
  let finalMessage: Record<string, unknown> | null = null;
  let stopReason = "stop";
  const piStream = provider.stream(model, context, {
    apiKey: token,
    reasoningEffort: bodyReasoningEffort(body, model.id),
    reasoningSummary: "auto",
    textVerbosity: bodyTextVerbosity(body),
    sessionId,
    transport: PI_TRANSPORT,
    timeoutMs: PI_TIMEOUT_MS,
    websocketConnectTimeoutMs: 15000,
    maxRetries: 1,
    signal,
    onPayload: (payload: Record<string, unknown>) => {
      logLine("responses.pi_payload", {
        model: model.id,
        inputItems: Array.isArray(payload.input) ? payload.input.length : null,
        toolsOut: Array.isArray(payload.tools) ? payload.tools.length : 0,
        reasoningEffort: piPayloadReasoningEffort(payload),
        transport: PI_TRANSPORT,
      });
    },
    onResponse: (response: { status: number; headers?: Record<string, string> }) => {
      logLine("responses.upstream", {
        status: response.status,
        contentType: response.headers?.["content-type"] || "",
        runtime: "pi",
      });
    },
  });

  for await (const rawEvent of piStream) {
    const event = rawEvent as PiStreamEvent;
    const contentIndex = piIndex(event.contentIndex);

    if (event.type === "text_start") {
      const item: ResponseOutputItem = {
        id: `msg_${randomUUID().replace(/-/g, "")}`,
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [{ type: "output_text", text: "", annotations: [] }],
      };
      output.push(item);
      openItems.set(contentIndex, { item, text: "", kind: "text" });
      continue;
    }

    if (event.type === "text_delta") {
      const entry = openItems.get(contentIndex);
      if (!entry || entry.kind !== "text") continue;
      entry.text = `${entry.text ?? ""}${piString(event.delta)}`;
      const part = piContentPart(entry.item);
      if (part) part.text = entry.text;
      continue;
    }

    if (event.type === "text_end") {
      const entry = openItems.get(contentIndex);
      if (!entry || entry.kind !== "text") continue;
      entry.text = piString(event.content);
      entry.item.status = "completed";
      const part = piContentPart(entry.item);
      if (part) part.text = entry.text;
      openItems.delete(contentIndex);
      continue;
    }

    if (event.type === "toolcall_start") {
      const partial = isPlainObject(event.partial) ? event.partial : {};
      const partialContent = Array.isArray(partial.content) ? partial.content : [];
      const block = isPlainObject(partialContent[contentIndex]) ? partialContent[contentIndex] : {};
      const ids = normalizeToolCallIds({
        id: String(block.id || ""),
        call_id: String(block.id || "").split("|")[0] || undefined,
      });
      const item: ResponseOutputItem = {
        id: ids.itemId,
        type: "function_call",
        call_id: ids.callId,
        name: typeof block.name === "string" ? block.name : "tool",
        arguments: "",
        status: "in_progress",
      };
      output.push(item);
      openItems.set(contentIndex, { item, args: "", kind: "tool" });
      continue;
    }

    if (event.type === "toolcall_delta") {
      const entry = openItems.get(contentIndex);
      if (!entry || entry.kind !== "tool") continue;
      entry.args = `${entry.args ?? ""}${piString(event.delta)}`;
      entry.item.arguments = entry.args;
      continue;
    }

    if (event.type === "toolcall_end") {
      const entry = openItems.get(contentIndex);
      if (!entry || entry.kind !== "tool") continue;
      const toolCall = isPlainObject(event.toolCall) ? event.toolCall : {};
      const toolCallId = typeof toolCall.id === "string" ? toolCall.id : "";
      const ids = normalizeToolCallIds({
        id: toolCallId.split("|")[1] || String(entry.item.id || ""),
        call_id: toolCallId.split("|")[0] || String(entry.item.call_id || ""),
      });
      entry.item.id = ids.itemId;
      entry.item.call_id = ids.callId;
      entry.item.name = typeof toolCall.name === "string" ? toolCall.name : entry.item.name;
      entry.item.arguments = JSON.stringify(toolCall.arguments ?? parseJsonObject(entry.args));
      entry.item.status = "completed";
      openItems.delete(contentIndex);
      continue;
    }

    if (event.type === "done") {
      finalMessage = isPlainObject(event.message) ? event.message : null;
      stopReason = piString(event.reason);
      break;
    }

    if (event.type === "error") {
      const errorPayload = isPlainObject(event.error) ? event.error : {};
      const message =
        typeof errorPayload.errorMessage === "string" ? errorPayload.errorMessage : "Pi stream failed";
      throw new Error(message);
    }
  }

  return {
    output,
    usage: normalizeResponseUsage(usageRecord(finalMessage?.usage)),
    status: stopReason === "length" ? "incomplete" : "completed",
    stopReason,
  };
}

function codexHeaders(token: string, accountId: string, req: IncomingMessage | null) {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("chatgpt-account-id", accountId);
  headers.set("originator", ORIGINATOR);
  headers.set("User-Agent", `codexsub (${platform()} ${release()}; ${arch()})`);
  headers.set("OpenAI-Beta", "responses=experimental");
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");

  const sessionId =
    req?.headers["session-id"] ||
    req?.headers["x-client-request-id"] ||
    req?.headers["x-request-id"] ||
    randomUUID();
  headers.set("session-id", String(sessionId));
  headers.set("x-client-request-id", String(sessionId));
  return headers;
}

async function forwardResponsesPi(req: IncomingMessage, res: ServerResponse, bodyText: string) {
  const startedAt = Date.now();
  const normalized = normalizeRequestBodyForBridge(bodyText, { req });
  const body = JSON.parse(normalized.body) as Record<string, unknown>;
  const { provider, models } = await loadPiRuntime();
  const requestedModel = typeof body.model === "string" ? body.model : DEFAULT_MODEL;
  const model = models.get(requestedModel) || models.get(DEFAULT_MODEL);
  if (!model) {
    throw new Error(`Pi OpenAI Codex model is not available: ${body.model}`);
  }

  const { token } = await loadCodexAuth();
  const { context, toolsOut } = responsesBodyToPiContext(body);
  const sessionId = String(
    req.headers["session-id"] ||
      req.headers["x-client-request-id"] ||
      req.headers["x-request-id"] ||
      randomUUID(),
  );
  const responseId = `resp_${randomUUID().replace(/-/g, "")}`;
  const output: ResponseOutputItem[] = [];
  const openItems = new Map<number, PiOpenItem>();
  let headerLogged = false;
  const streamStartedAt = Date.now();
  const { recordWrite, getBytes } = createSseRecorder(res, COPILOT_SSE_DATA_ONLY);

  logLine("responses.forward", {
    path: req.url,
    model: model.id,
    stream: normalized.info.stream,
    inputType: normalized.info.inputType,
    toolsIn: normalized.info.toolsIn,
    toolsOut,
    strippedTools: false,
    strippedParams: normalized.info.strippedParams,
    reasoningEffort: normalized.info.reasoningEffort,
    runtime: "pi",
    transport: PI_TRANSPORT,
  });

  const jsonResponseMode = body.stream === false;
  if (jsonResponseMode) {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    const collected = await collectPiResponse({
      provider,
      model,
      context,
      token,
      sessionId,
      body,
      signal: controller.signal,
    });
    const responsePayload = responseObject({
      id: responseId,
      model: model.id,
      status: collected.status,
      output: collected.output,
      usage: collected.usage,
    });
    json(res, 200, responsePayload);
    logLine("responses.complete", {
      status: 200,
      model: model.id,
      stream: body.stream,
      responseFormat: "json",
      totalMs: Date.now() - startedAt,
      runtime: "pi",
      stopReason: collected.stopReason,
    });
    return;
  }

  beginResponsesSseStream(res, {
    "x-sub-bridge-runtime": "pi",
    "x-sub-bridge-transport": PI_TRANSPORT,
    ...(normalized.info.strippedParams.length > 0
      ? { "x-sub-bridge-stripped-params": normalized.info.strippedParams.join(",") }
      : {}),
  });

  recordWrite("response.created", {
    response: responseObject({ id: responseId, model: model.id, output }),
  });
  emitResponseInProgress(recordWrite, responseObject({ id: responseId, model: model.id, output }));
  flushResponsesSseStream(res);

  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  let piStream;
  try {
    piStream = provider.stream(model, context, {
      apiKey: token,
      reasoningEffort: bodyReasoningEffort(body, model.id),
      reasoningSummary: "auto",
      textVerbosity: bodyTextVerbosity(body),
      sessionId,
      transport: PI_TRANSPORT,
      timeoutMs: PI_TIMEOUT_MS,
      websocketConnectTimeoutMs: 15000,
      maxRetries: 1,
      signal: controller.signal,
      onPayload: (payload: Record<string, unknown>) => {
        logLine("responses.pi_payload", {
          model: model.id,
          inputItems: Array.isArray(payload.input) ? payload.input.length : null,
          toolsOut: Array.isArray(payload.tools) ? payload.tools.length : 0,
          reasoningEffort: piPayloadReasoningEffort(payload),
          transport: PI_TRANSPORT,
        });
      },
      onResponse: (response: { status: number; headers?: Record<string, string> }) => {
        headerLogged = true;
        logLine("responses.upstream", {
          status: response.status,
          contentType: response.headers?.["content-type"] || "",
          upstreamHeaderMs: Date.now() - streamStartedAt,
          totalHeaderMs: Date.now() - startedAt,
          runtime: "pi",
        });
      },
    });
  } catch (error: unknown) {
    throw error;
  }

  const finishOpenPiItems = () => {
    for (const entry of openItems.values()) {
      if (entry.kind === "text") {
        entry.item.status = "completed";
        const part = piContentPart(entry.item);
        if (part) part.text = entry.text ?? "";
        recordWrite("response.output_text.done", {
          item_id: entry.item.id,
          output_index: entry.outputIndex,
          content_index: 0,
          text: entry.text,
        });
        recordWrite("response.content_part.done", {
          item_id: entry.item.id,
          output_index: entry.outputIndex,
          content_index: 0,
          part: piContentPart(entry.item),
        });
        recordWrite("response.output_item.done", {
          output_index: entry.outputIndex,
          item: entry.item,
        });
      } else if (entry.kind === "tool") {
        entry.item.status = "completed";
        recordWrite("response.function_call_arguments.done", {
          item_id: entry.item.id,
          output_index: entry.outputIndex,
          arguments: entry.item.arguments || entry.args || "{}",
        });
        recordWrite("response.output_item.done", {
          output_index: entry.outputIndex,
          item: entry.item,
        });
      }
    }
    openItems.clear();
  };

  const completeCancelledPiStream = (error: unknown) => {
    const message = errorMessage(error);
    if (!res.writableEnded && !res.destroyed) {
      finishOpenPiItems();
      recordWrite("response.completed", {
        response: responseObject({
          id: responseId,
          model: model.id,
          status: "completed",
          output,
        }),
      });
      sseDone(res);
      res.end();
    }
    logLine("responses.cancelled", {
      status: 200,
      model: model.id,
      totalMs: Date.now() - startedAt,
      message,
      runtime: "pi",
    });
  };

  const failPiStream = (error: unknown) => {
    const message = errorMessage(error) || "Pi stream failed";
    if (!res.writableEnded && !res.destroyed) {
      recordWrite("response.failed", {
        response: responseObject({
          id: responseId,
          model: model.id,
          status: "failed",
          output,
          error: { message, type: "bridge_error" },
        }),
      });
      sseDone(res);
      res.end();
    }
    logLine("responses.stream_error", {
      status: 200,
      model: model.id,
      totalMs: Date.now() - startedAt,
      message,
      runtime: "pi",
    });
  };

  let finalMessage: Record<string, unknown> | null = null;
  try {
    for await (const rawEvent of piStream) {
    const event = rawEvent as PiStreamEvent;
    const contentIndex = piIndex(event.contentIndex);
    if (!headerLogged && event.type === "start") {
      headerLogged = true;
      logLine("responses.upstream", {
        status: 200,
        contentType: "text/event-stream",
        upstreamHeaderMs: Date.now() - streamStartedAt,
        totalHeaderMs: Date.now() - startedAt,
        runtime: "pi",
      });
    }

    if (event.type === "text_start") {
      const itemId = `msg_${randomUUID().replace(/-/g, "")}`;
      const outputIndex = output.length;
      const item: ResponseOutputItem = {
        id: itemId,
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [] as MessageContentPart[],
      };
      output.push(item);
      openItems.set(contentIndex, { outputIndex, item, text: "", kind: "text" });
      recordWrite("response.output_item.added", { output_index: outputIndex, item });
      const part: MessageContentPart = { type: "output_text", text: "", annotations: [] };
      (item.content as MessageContentPart[]).push(part);
      recordWrite("response.content_part.added", {
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        part,
      });
      continue;
    }

    if (event.type === "text_delta") {
      const entry = openItems.get(contentIndex);
      if (!entry || entry.kind !== "text") continue;
      entry.text = `${entry.text ?? ""}${piString(event.delta)}`;
      const part = piContentPart(entry.item);
      if (part) part.text = entry.text;
      recordWrite("response.output_text.delta", {
        item_id: entry.item.id,
        output_index: entry.outputIndex,
        content_index: 0,
        delta: event.delta,
      });
      continue;
    }

    if (event.type === "text_end") {
      const entry = openItems.get(contentIndex);
      if (!entry || entry.kind !== "text") continue;
      entry.text = piString(event.content);
      entry.item.status = "completed";
      const endPart = piContentPart(entry.item);
      if (endPart) endPart.text = entry.text;
      recordWrite("response.output_text.done", {
        item_id: entry.item.id,
        output_index: entry.outputIndex,
        content_index: 0,
        text: entry.text,
      });
      recordWrite("response.content_part.done", {
        item_id: entry.item.id,
        output_index: entry.outputIndex,
        content_index: 0,
        part: piContentPart(entry.item),
      });
      recordWrite("response.output_item.done", {
        output_index: entry.outputIndex,
        item: entry.item,
      });
      openItems.delete(contentIndex);
      continue;
    }

    if (event.type === "toolcall_start") {
      const partial = isPlainObject(event.partial) ? event.partial : {};
      const partialContent = Array.isArray(partial.content) ? partial.content : [];
      const block = isPlainObject(partialContent[contentIndex]) ? partialContent[contentIndex] : {};
      const ids = normalizeToolCallIds({
        id: String(block.id || ""),
        call_id: String(block.id || "").split("|")[0] || undefined,
      });
      const outputIndex = output.length;
      const item: ResponseOutputItem = {
        id: ids.itemId,
        type: "function_call",
        call_id: ids.callId,
        name: typeof block.name === "string" ? block.name : "tool",
        arguments: "",
        status: "in_progress",
      };
      output.push(item);
      openItems.set(contentIndex, { outputIndex, item, args: "", kind: "tool" });
      recordWrite("response.output_item.added", { output_index: outputIndex, item });
      continue;
    }

    if (event.type === "toolcall_delta") {
      const entry = openItems.get(contentIndex);
      if (!entry || entry.kind !== "tool") continue;
      entry.args = `${entry.args ?? ""}${piString(event.delta)}`;
      entry.item.arguments = entry.args;
      recordWrite("response.function_call_arguments.delta", {
        item_id: entry.item.id,
        output_index: entry.outputIndex,
        delta: event.delta,
      });
      continue;
    }

    if (event.type === "toolcall_end") {
      const entry = openItems.get(contentIndex);
      if (!entry || entry.kind !== "tool") continue;
      const toolCall = isPlainObject(event.toolCall) ? event.toolCall : {};
      const toolCallId = typeof toolCall.id === "string" ? toolCall.id : "";
      const ids = normalizeToolCallIds({
        id: toolCallId.split("|")[1] || String(entry.item.id || ""),
        call_id: toolCallId.split("|")[0] || String(entry.item.call_id || ""),
      });
      const args = JSON.stringify(toolCall.arguments ?? parseJsonObject(entry.args));
      entry.item.id = ids.itemId;
      entry.item.call_id = ids.callId;
      entry.item.name = typeof toolCall.name === "string" ? toolCall.name : entry.item.name;
      entry.item.arguments = args;
      entry.item.status = "completed";
      recordWrite("response.function_call_arguments.done", {
        item_id: entry.item.id,
        output_index: entry.outputIndex,
        arguments: args,
      });
      recordWrite("response.output_item.done", {
        output_index: entry.outputIndex,
        item: entry.item,
      });
      openItems.delete(contentIndex);
      continue;
    }

    if (event.type === "done") {
      finalMessage = isPlainObject(event.message) ? event.message : null;
      const usage = normalizeResponseUsage(usageRecord(finalMessage?.usage));
      recordWrite("response.completed", {
        response: responseObject({
          id: responseId,
          model: model.id,
          status: piString(event.reason) === "length" ? "incomplete" : "completed",
          output,
          usage,
        }),
      });
      sseDone(res);
      res.end();
      logLine("responses.complete", {
        status: 200,
        model: model.id,
        streamMs: Date.now() - streamStartedAt,
        totalMs: Date.now() - startedAt,
        bytes: getBytes(),
        runtime: "pi",
        stopReason: event.reason,
      });
      return;
    }

    if (event.type === "error") {
      const errorPayload = isPlainObject(event.error) ? event.error : {};
      const message =
        typeof errorPayload.errorMessage === "string" ? errorPayload.errorMessage : "Pi stream failed";
      if (isAbortLikeError(event.error) || isAbortLikeError(message) || controller.signal.aborted || res.destroyed) {
        completeCancelledPiStream(event.error || message);
        return;
      }
      recordWrite("response.failed", {
        response: responseObject({
          id: responseId,
          model: model.id,
          status: "failed",
          output,
          usage: normalizeResponseUsage(
            usageRecord(isPlainObject(event.error) ? event.error.usage : null),
          ),
          error: { message, type: "bridge_error" },
        }),
      });
      sseDone(res);
      res.end();
      logLine("responses.stream_error", {
        status: 200,
        model: model.id,
        totalMs: Date.now() - startedAt,
        message,
        runtime: "pi",
      });
      return;
    }
  }
  } catch (error: unknown) {
    if (isAbortLikeError(error) || controller.signal.aborted || res.destroyed) {
      completeCancelledPiStream(error);
      return;
    }
    if (isRetryableTransientError(error) && output.length === 0) {
      logLine("responses.retry_skipped", {
        model: model.id,
        totalMs: Date.now() - startedAt,
        message: errorMessage(error),
        reason: "stream-already-created",
        runtime: "pi",
      });
    }
    failPiStream(error);
    return;
  }

  if (!finalMessage && !res.writableEnded) {
    recordWrite("response.failed", {
      response: responseObject({
        id: responseId,
        model: model.id,
        status: "failed",
        output,
        error: { message: "Pi stream ended without a terminal event", type: "bridge_error" },
      }),
    });
    sseDone(res);
    res.end();
  }
}

async function forwardResponsesRaw(req: IncomingMessage, res: ServerResponse, bodyText: string, retry = true) {
  const startedAt = Date.now();
  const { token, accountId } = await loadCodexAuth();
  const url = `${DEFAULT_CODEX_BASE_URL}${CODEX_RESPONSES_PATH}`;
  const normalized = normalizeRequestBodyForBridge(bodyText, { req });
  const body = normalized.body;
  logLine("responses.forward", {
    path: req.url,
    model: normalized.info.model,
    stream: normalized.info.stream,
    inputType: normalized.info.inputType,
    toolsIn: normalized.info.toolsIn,
    toolsOut: normalized.info.toolsOut,
    strippedTools: normalized.info.strippedTools,
    strippedParams: normalized.info.strippedParams,
    reasoningEffort: normalized.info.reasoningEffort,
  });
  const fetchStartedAt = Date.now();
  const upstream = await fetch(url, {
    method: "POST",
    headers: codexHeaders(token, accountId, req),
    body,
  });
  const upstreamHeaderMs = Date.now() - fetchStartedAt;

  if (upstream.status === 401 && retry) {
    await loadCodexAuth({ forceRefresh: true });
    return forwardResponsesRaw(req, res, bodyText, false);
  }

  const upstreamContentType = upstream.headers.get("content-type") || "";
  logLine("responses.upstream", {
    status: upstream.status,
    contentType: upstreamContentType,
    upstreamHeaderMs,
    totalHeaderMs: Date.now() - startedAt,
  });

  res.statusCode = upstream.status;
  res.setHeader("content-type", upstreamContentType || "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("x-codexsub-upstream-status", String(upstream.status));
  if (normalized.info.strippedTools) res.setHeader("x-gpt-sub-bridge-stripped-tools", "true");
  if (normalized.info.strippedParams.length > 0) {
    res.setHeader("x-gpt-sub-bridge-stripped-params", normalized.info.strippedParams.join(","));
  }
  const requestId = upstream.headers.get("x-request-id") || upstream.headers.get("openai-processing-ms");
  if (requestId) res.setHeader("x-codexsub-upstream-id", requestId);

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    logLine("responses.upstream_error", {
      status: upstream.status,
      contentType: upstreamContentType,
      bodyPrefix: logPrefix(text),
    });
    res.end(text);
    return;
  }

  if (!upstream.body) {
    res.end();
    return;
  }
  const streamStartedAt = Date.now();
  let bytes = 0;
  const upstreamStream = Readable.fromWeb(upstream.body);
  upstreamStream.on("data", (chunk) => {
    bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
  });
  upstreamStream.on("end", () => {
    logLine("responses.complete", {
      status: upstream.status,
      model: normalized.info.model,
      streamMs: Date.now() - streamStartedAt,
      totalMs: Date.now() - startedAt,
      bytes,
    });
  });
  upstreamStream.on("error", (error: unknown) => {
    logLine(isAbortLikeError(error) || res.destroyed ? "responses.cancelled" : "responses.stream_error", {
      status: upstream.status,
      model: normalized.info.model,
      totalMs: Date.now() - startedAt,
      message: errorMessage(error),
    });
  });
  upstreamStream.pipe(res);
}

async function forwardResponsesCursorAcp(req: IncomingMessage, res: ServerResponse, bodyText: string) {
  const startedAt = Date.now();
  const normalized = normalizeRequestBodyForBridge(bodyText, { stripTools: STRIP_COPILOT_TOOLS, req });
  const body = JSON.parse(normalized.body) as Record<string, unknown>;
  const copilotTools = Array.isArray(body.tools) ? body.tools : [];
  const responseId = `resp_${randomUUID().replace(/-/g, "")}`;
  const output: ResponseOutputItem[] = [];
  const requestModel = requestModelFromBody(body);
  const actualCursorModel = resolveCursorAcpModel(requestModel, {
    cursorModelSetting: CURSOR_MODEL,
    modelConfigFor: modelConfigForAcp,
  });

  logLine("responses.forward", {
    path: req.url,
    model: requestModel,
    cursorModel: actualCursorModel,
    stream: body.stream,
    inputType: normalized.info.inputType,
    toolsIn: normalized.info.toolsIn,
    toolsOut: normalized.info.toolsOut,
    strippedTools: normalized.info.strippedTools,
    strippedParams: normalized.info.strippedParams,
    reasoningEffort: normalized.info.reasoningEffort,
    runtime: "cursor-acp",
    command: CURSOR_ACP_COMMAND,
    workspace: CURSOR_WORKSPACE,
  });

  const runOptionsBase = {
    command: CURSOR_ACP_COMMAND,
    apiEndpoint: CURSOR_API_ENDPOINT || undefined,
    workspace: CURSOR_WORKSPACE,
    env: makeCursorRuntimeEnv(),
    timeoutMs: CURSOR_ACP_TIMEOUT_MS,
    model: actualCursorModel,
    reasoningEffort: reasoningEffortForModel(requestModel),
    modelOptions: acpModelOptions(requestModel, body),
    body,
    copilotToolNames: allowedCopilotToolNames(copilotTools),
    onStderr: (chunk: string | Buffer) => {
      const text = String(chunk || "").trim();
      if (text) logLine("cursor.stderr", { text: logPrefix(text, 500) });
    },
    onProtocolError: (error: Error) => {
      logLine("cursor.protocol_error", { message: error.message });
    },
  };

  if (body.stream === false) {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const result = await runCursorAcpTurn({ ...runOptionsBase, signal: controller.signal });
      appendCursorJsonOutputFromEvents(output, result.events, result.text, { copilotTools, log: logLine });
      json(res, 200, responseObject({
        id: responseId,
        model: requestModel,
        status: "completed",
        output,
        usage: result.usage,
      }));
      logLine("responses.complete", {
        status: 200,
        model: requestModel,
        cursorModel: actualCursorModel,
        responseFormat: "json",
        totalMs: Date.now() - startedAt,
        runtime: "cursor-acp",
        stopReason: result.stopReason,
      });
    } catch (error: unknown) {
      const message = errorMessage(error);
      if (isAbortLikeError(error) || controller.signal.aborted || res.destroyed) {
        logLine("responses.cancelled", {
          status: 200,
          model: requestModel,
          cursorModel: actualCursorModel,
          responseFormat: "json",
          totalMs: Date.now() - startedAt,
          message,
          runtime: "cursor-acp",
        });
        if (!res.writableEnded && !res.destroyed) {
          json(res, 200, responseObject({
            id: responseId,
            model: requestModel,
            status: "completed",
            output,
          }));
        }
        return;
      }
      output.push({
        id: `msg_${randomUUID().replace(/-/g, "")}`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: `Cursor ACP error: ${message}`, annotations: [] }],
      });
      json(res, 200, responseObject({
        id: responseId,
        model: requestModel,
        status: "completed",
        output,
      }));
      logLine("responses.stream_error", {
        status: 200,
        model: requestModel,
        cursorModel: actualCursorModel,
        responseFormat: "json",
        totalMs: Date.now() - startedAt,
        message,
        runtime: "cursor-acp",
      });
    }
    return;
  }

  beginResponsesSseStream(res, {
    "x-sub-bridge-runtime": "cursor-acp",
    "x-sub-bridge-cursor-model": actualCursorModel,
  });

  const { recordWrite, getBytes } = createSseRecorder(res, COPILOT_SSE_DATA_ONLY);

  recordWrite("response.created", {
    response: responseObject({ id: responseId, model: requestModel, output }),
  });
  emitResponseInProgress(recordWrite, responseObject({ id: responseId, model: requestModel, output }));
  flushResponsesSseStream(res);

  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  let nextOutputIndex = 0;
  let assistantEntry: CursorStreamAssistantEntry | null = null;
  let reasoningEntry: CursorStreamReasoningEntry | null = null;
  const toolEntries = new Map<string, CursorToolEntry>();

  const addOutputItem = (item: ResponseOutputItem) => {
    const outputIndex = nextOutputIndex;
    nextOutputIndex += 1;
    output.push(item);
    recordWrite("response.output_item.added", { output_index: outputIndex, item });
    return outputIndex;
  };

  const ensureAssistantEntry = (): CursorStreamAssistantEntry => {
    if (assistantEntry) return assistantEntry;
    const item: CursorStreamAssistantEntry["item"] = {
      id: `msg_${randomUUID().replace(/-/g, "")}`,
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: [],
    };
    const outputIndex = addOutputItem(item);
    const part: MessageContentPart = { type: "output_text", text: "", annotations: [] };
    item.content.push(part);
    recordWrite("response.content_part.added", {
      item_id: item.id,
      output_index: outputIndex,
      content_index: 0,
      part,
    });
    assistantEntry = { item, part, outputIndex, text: "" };
    return assistantEntry;
  };

  const finishAssistantEntry = () => {
    if (!assistantEntry) return;
    const entry = assistantEntry;
    const extracted = extractCopilotToolCallsFromText(entry.text, allowedCopilotToolNames(copilotTools));
    entry.text = extracted.text;
    entry.part.text = entry.text;
    for (const call of extracted.calls) {
      const outputIndex = addOutputItem(call);
      recordWrite("response.function_call_arguments.done", {
        item_id: call.id,
        output_index: outputIndex,
        arguments: call.arguments,
      });
      recordWrite("response.output_item.done", { output_index: outputIndex, item: call });
    }
    entry.item.status = "completed";
    recordWrite("response.output_text.done", {
      item_id: entry.item.id,
      output_index: entry.outputIndex,
      content_index: 0,
      text: entry.text,
    });
    recordWrite("response.content_part.done", {
      item_id: entry.item.id,
      output_index: entry.outputIndex,
      content_index: 0,
      part: entry.part,
    });
    recordWrite("response.output_item.done", { output_index: entry.outputIndex, item: entry.item });
    assistantEntry = null;
  };

  const emitAssistantTextItem = (text: string) => {
    const item: CursorStreamAssistantEntry["item"] = {
      id: `msg_${randomUUID().replace(/-/g, "")}`,
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: [],
    };
    const outputIndex = addOutputItem(item);
    const part: MessageContentPart = { type: "output_text", text: "", annotations: [] };
    item.content.push(part);
    recordWrite("response.content_part.added", {
      item_id: item.id,
      output_index: outputIndex,
      content_index: 0,
      part,
    });
    part.text = text;
    recordWrite("response.output_text.delta", {
      item_id: item.id,
      output_index: outputIndex,
      content_index: 0,
      delta: text,
    });
    item.status = "completed";
    recordWrite("response.output_text.done", {
      item_id: item.id,
      output_index: outputIndex,
      content_index: 0,
      text,
    });
    recordWrite("response.content_part.done", {
      item_id: item.id,
      output_index: outputIndex,
      content_index: 0,
      part,
    });
    recordWrite("response.output_item.done", { output_index: outputIndex, item });
  };

  const ensureReasoningEntry = (): CursorStreamReasoningEntry => {
    if (reasoningEntry) return reasoningEntry;
    const item: CursorStreamReasoningEntry["item"] = {
      id: `rs_${randomUUID().replace(/-/g, "")}`,
      type: "reasoning",
      status: "in_progress",
      summary: [],
    };
    const outputIndex = addOutputItem(item);
    const part: ReasoningSummaryPart = { type: "summary_text", text: "" };
    item.summary.push(part);
    recordWrite("response.reasoning_summary_part.added", {
      item_id: item.id,
      output_index: outputIndex,
      summary_index: 0,
      part,
    });
    reasoningEntry = { item, part, outputIndex, text: "" };
    return reasoningEntry;
  };

  const finishReasoningEntry = () => {
    if (!reasoningEntry) return;
    const entry = reasoningEntry;
    entry.item.status = "completed";
    entry.part.text = entry.text;
    recordWrite("response.reasoning_summary_text.done", {
      item_id: entry.item.id,
      output_index: entry.outputIndex,
      summary_index: 0,
      text: entry.text,
    });
    recordWrite("response.reasoning_summary_part.done", {
      item_id: entry.item.id,
      output_index: entry.outputIndex,
      summary_index: 0,
      part: entry.part,
    });
    recordWrite("response.output_item.done", { output_index: entry.outputIndex, item: entry.item });
    reasoningEntry = null;
  };

  const appendReasoningText = (text: string) => {
    const entry = ensureReasoningEntry();
    entry.text += text;
    entry.part.text = entry.text;
    recordWrite("response.reasoning_summary_text.delta", {
      item_id: entry.item.id,
      output_index: entry.outputIndex,
      summary_index: 0,
      delta: text,
    });
  };

  const applyToolCallEvent = (eventToolCall: Record<string, unknown>) => {
    finishAssistantEntry();
    const toolCall = eventToolCall;
    logLine("cursor.tool_call", JSON.parse(cursorToolArguments(toolCall)));
    const toolCallId = typeof toolCall.id === "string" ? toolCall.id : String(toolCall.id ?? "");
    let entry = toolEntries.get(toolCallId);
    if (!entry) {
      const item = cursorToolCallToFunctionCallItem(toolCall);
      const outputIndex = addOutputItem(item);
      entry = { toolCall, item, outputIndex, terminalReported: false };
      toolEntries.set(toolCallId, entry);
      recordWrite("response.function_call_arguments.delta", {
        item_id: item.id,
        output_index: outputIndex,
        delta: item.arguments,
      });
    } else {
      entry.toolCall = toolCall;
      entry.item.name = cursorToolName(toolCall);
      entry.item.arguments = cursorToolArguments(toolCall);
    }
    const toolStatus = typeof toolCall.status === "string" ? toolCall.status : undefined;
    if (cursorToolStatusIsTerminal(toolStatus) && !entry.terminalReported) {
      entry.item.status = "completed";
      recordWrite("response.function_call_arguments.done", {
        item_id: entry.item.id,
        output_index: entry.outputIndex,
        arguments: entry.item.arguments,
      });
      recordWrite("response.output_item.done", { output_index: entry.outputIndex, item: entry.item });
      entry.terminalReported = true;
      toolEntries.delete(toolCallId);
    }
  };

  const finishOpenToolEntries = () => {
    for (const entry of toolEntries.values()) {
      if (entry.terminalReported) continue;
      entry.item.status = "completed";
      recordWrite("response.function_call_arguments.done", {
        item_id: entry.item.id,
        output_index: entry.outputIndex,
        arguments: entry.item.arguments || "{}",
      });
      recordWrite("response.output_item.done", { output_index: entry.outputIndex, item: entry.item });
      entry.terminalReported = true;
    }
    toolEntries.clear();
  };

  const applyExtensionEvent = (payload: unknown, eventType: string) => {
    finishAssistantEntry();
    const payloadRecord = isPlainObject(payload) ? payload : {};
    logLine(`cursor.${eventType}`, payloadRecord);
    const item = cursorExtensionPayloadToFunctionCallItem(payloadRecord);
    const outputIndex = addOutputItem(item);
    recordWrite("response.function_call_arguments.delta", {
      item_id: item.id,
      output_index: outputIndex,
      delta: item.arguments,
    });
    recordWrite("response.function_call_arguments.done", {
      item_id: item.id,
      output_index: outputIndex,
      arguments: item.arguments,
    });
    recordWrite("response.output_item.done", { output_index: outputIndex, item });
  };

  const applyCopilotToolCallEvent = (event: AcpProcessorEvent) => {
    finishAssistantEntry();
    logLine("cursor.copilot_tool_call", { name: event.name, arguments: event.arguments });
    const item = copilotNativeToolCallToFunctionCallItem({
      name: typeof event.name === "string" ? event.name : "tool",
      arguments: event.arguments,
    });
    const outputIndex = addOutputItem(item);
    recordWrite("response.function_call_arguments.delta", {
      item_id: item.id,
      output_index: outputIndex,
      delta: item.arguments,
    });
    recordWrite("response.function_call_arguments.done", {
      item_id: item.id,
      output_index: outputIndex,
      arguments: item.arguments,
    });
    recordWrite("response.output_item.done", { output_index: outputIndex, item });
  };

  const applyCursorEvent = (event: AcpProcessorEvent) => {
    if (event.type === "assistant_segment_completed") {
      finishAssistantEntry();
      return;
    }
    if (event.type === "content_delta" && event.streamKind === "assistant_text" && typeof event.text === "string") {
      const entry = ensureAssistantEntry();
      entry.text += event.text;
      entry.part.text = entry.text;
      recordWrite("response.output_text.delta", {
        item_id: entry.item.id,
        output_index: entry.outputIndex,
        content_index: 0,
        delta: event.text,
      });
      return;
    }
    if (event.type === "content_delta" && event.streamKind === "reasoning_text" && typeof event.text === "string") {
      appendReasoningText(event.text);
      return;
    }
    if (event.type === "tool_call" && isPlainObject(event.toolCall)) {
      applyToolCallEvent(event.toolCall);
      return;
    }
    if (event.type === "plan_updated" || event.type === "question_asked") {
      applyExtensionEvent(event.payload, event.type);
      return;
    }
    if (event.type === "copilot_tool_call") {
      applyCopilotToolCallEvent(event);
    }
  };

  try {
    const result = await runCursorAcpTurn({
      ...runOptionsBase,
      signal: controller.signal,
      onEvent: applyCursorEvent,
    });
    finishReasoningEntry();
    finishAssistantEntry();
    finishOpenToolEntries();
    stripCompanionAssistantMessagesWhenFunctionCalls(output);
    recordWrite("response.completed", {
      response: responseObject({
        id: responseId,
        model: requestModel,
        status: "completed",
        output,
        usage: result.usage,
      }),
    });
    sseDone(res);
    res.end();
    logLine("responses.complete", {
      status: 200,
      model: requestModel,
      cursorModel: actualCursorModel,
      totalMs: Date.now() - startedAt,
      bytes: getBytes(),
      runtime: "cursor-acp",
      stopReason: result.stopReason,
    });
  } catch (error: unknown) {
    const message = errorMessage(error);
    if (isAbortLikeError(error) || controller.signal.aborted || res.destroyed) {
      if (!res.writableEnded && !res.destroyed) {
        finishReasoningEntry();
        finishAssistantEntry();
        finishOpenToolEntries();
        recordWrite("response.completed", {
          response: responseObject({
            id: responseId,
            model: requestModel,
            status: "completed",
            output,
          }),
        });
        sseDone(res);
        res.end();
      }
      logLine("responses.cancelled", {
        status: 200,
        model: requestModel,
        cursorModel: actualCursorModel,
        totalMs: Date.now() - startedAt,
        message,
        runtime: "cursor-acp",
      });
      return;
    }
    finishReasoningEntry();
    finishAssistantEntry();
    finishOpenToolEntries();
    emitAssistantTextItem(`Cursor ACP error: ${message}`);
    recordWrite("response.completed", {
      response: responseObject({
        id: responseId,
        model: requestModel,
        status: "completed",
        output,
      }),
    });
    sseDone(res);
    res.end();
    logLine("responses.stream_error", {
      status: 200,
      model: requestModel,
      cursorModel: actualCursorModel,
      totalMs: Date.now() - startedAt,
      message,
      runtime: "cursor-acp",
    });
  }
}

async function forwardChatCompletionsCursorAcp(req: IncomingMessage, res: ServerResponse, bodyText: string) {
  const startedAt = Date.now();
  const chatBody = JSON.parse(bodyText) as Record<string, unknown>;
  const responsesBody = chatCompletionsBodyToResponsesBody(chatBody);
  const normalized = normalizeRequestBodyForBridge(JSON.stringify(responsesBody), { stripTools: STRIP_COPILOT_TOOLS, req });
  const body = JSON.parse(normalized.body) as Record<string, unknown>;
  const copilotTools = Array.isArray(body.tools) ? body.tools : [];
  const completionId = `chatcmpl_${randomUUID().replace(/-/g, "")}`;
  const output: ResponseOutputItem[] = [];
  const requestModel = requestModelFromBody(body);
  const actualCursorModel = resolveCursorAcpModel(requestModel, {
    cursorModelSetting: CURSOR_MODEL,
    modelConfigFor: modelConfigForAcp,
  });

  logLine("completions.forward", {
    path: req.url,
    model: requestModel,
    cursorModel: actualCursorModel,
    stream: body.stream,
    inputMessages: Array.isArray(chatBody.messages) ? chatBody.messages.length : 0,
    toolsIn: normalized.info.toolsIn,
    toolsOut: normalized.info.toolsOut,
    runtime: "cursor-acp",
  });

  const runOptionsBase = {
    command: CURSOR_ACP_COMMAND,
    apiEndpoint: CURSOR_API_ENDPOINT || undefined,
    workspace: CURSOR_WORKSPACE,
    env: makeCursorRuntimeEnv(),
    timeoutMs: CURSOR_ACP_TIMEOUT_MS,
    model: actualCursorModel,
    reasoningEffort: reasoningEffortForModel(requestModel),
    modelOptions: acpModelOptions(requestModel, body),
    body,
    copilotToolNames: allowedCopilotToolNames(copilotTools),
    onStderr: (chunk: string | Buffer) => {
      const text = String(chunk || "").trim();
      if (text) logLine("cursor.stderr", { text: logPrefix(text, 500) });
    },
    onProtocolError: (error: Error) => {
      logLine("cursor.protocol_error", { message: error.message });
    },
  };

  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  if (body.stream === false) {
    try {
      const result = await runCursorAcpTurn({ ...runOptionsBase, signal: controller.signal });
      appendCursorJsonOutputFromEvents(output, result.events, result.text, { copilotTools, log: logLine });
      stripCompanionAssistantMessagesWhenFunctionCalls(output);
      const message = chatMessageFromResponsesOutput(output);
      json(res, 200, chatCompletionObject({
        id: completionId,
        model: requestModel,
        message,
        usage: result.usage,
        finishReason: result.stopReason === "end_turn" ? "stop" : "stop",
      }));
      logLine("completions.complete", {
        status: 200,
        model: requestModel,
        cursorModel: actualCursorModel,
        responseFormat: "json",
        totalMs: Date.now() - startedAt,
        runtime: "cursor-acp",
        stopReason: result.stopReason,
      });
    } catch (error: unknown) {
      const message = errorMessage(error);
      if (isAbortLikeError(error) || controller.signal.aborted || res.destroyed) {
        logLine("completions.cancelled", { status: 200, model: requestModel, totalMs: Date.now() - startedAt, message });
        return;
      }
      json(res, 200, chatCompletionObject({
        id: completionId,
        model: requestModel,
        message: { role: "assistant", content: `Cursor ACP error: ${message}` },
        finishReason: "stop",
      }));
      logLine("completions.error", { status: 200, model: requestModel, totalMs: Date.now() - startedAt, message });
    }
    return;
  }

  beginResponsesSseStream(res, {
    "x-sub-bridge-runtime": "cursor-acp",
    "x-sub-bridge-cursor-model": actualCursorModel,
    "x-sub-bridge-wire-api": "completions",
  });

  let roleSent = false;
  let toolIndex = 0;
  const writeChunk = (delta: Record<string, unknown>, finishReason: string | null = null) => {
    const choice: { index: number; delta: Record<string, unknown>; finish_reason?: string } = { index: 0, delta: delta || {} };
    if (finishReason) choice.finish_reason = finishReason;
    const payload = formatChatCompletionSseChunk({
      id: completionId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: requestModel,
      choices: [choice],
    });
    const socket = res.socket;
    if (typeof socket?.cork === "function") socket.cork();
    res.write(payload);
    if (typeof socket?.uncork === "function") socket.uncork();
  };

  const applyStreamEvent = (event: AcpProcessorEvent) => {
    if (event.type === "content_delta" && event.streamKind === "assistant_text" && typeof event.text === "string") {
      if (!roleSent) {
        writeChunk({ role: "assistant", content: "" });
        roleSent = true;
      }
      writeChunk({ content: event.text });
      return;
    }
    if (event.type === "tool_call" && isPlainObject(event.toolCall) && cursorToolStatusIsTerminal(
      typeof event.toolCall.status === "string" ? event.toolCall.status : undefined,
    )) {
      const item = cursorToolCallToFunctionCallItem(event.toolCall);
      writeChunk({
        tool_calls: [{
          index: toolIndex,
          id: item.call_id,
          type: "function",
          function: { name: item.name, arguments: item.arguments },
        }],
      });
      toolIndex += 1;
    }
  };

  flushResponsesSseStream(res);
  try {
    const result = await runCursorAcpTurn({
      ...runOptionsBase,
      signal: controller.signal,
      onEvent: applyStreamEvent,
    });
    if (!roleSent && result.text) {
      writeChunk({ role: "assistant", content: result.text });
      roleSent = true;
    }
    writeChunk({}, "stop");
    res.write("data: [DONE]\n\n");
    res.end();
    logLine("completions.complete", {
      status: 200,
      model: requestModel,
      cursorModel: actualCursorModel,
      responseFormat: "sse",
      totalMs: Date.now() - startedAt,
      runtime: "cursor-acp",
      stopReason: result.stopReason,
    });
  } catch (error: unknown) {
    const message = errorMessage(error);
    if (!isAbortLikeError(error) && !controller.signal.aborted && !res.destroyed) {
      writeChunk({ content: `Cursor ACP error: ${message}` });
      writeChunk({}, "stop");
      res.write("data: [DONE]\n\n");
      res.end();
    }
    logLine(isAbortLikeError(error) ? "completions.cancelled" : "completions.error", {
      status: 200,
      model: requestModel,
      totalMs: Date.now() - startedAt,
      message,
    });
  }
}

async function forwardChatCompletions(req: IncomingMessage, res: ServerResponse, bodyText: string) {
  if (BACKEND === "cursor-acp" || BACKEND === "cursor") {
    return forwardChatCompletionsCursorAcp(req, res, bodyText);
  }
  json(res, 501, {
    error: {
      message: `Chat completions wire API is not implemented for backend ${BACKEND}`,
      type: "unsupported_backend",
    },
  });
}

async function forwardResponses(req: IncomingMessage, res: ServerResponse, bodyText: string) {
  return PROVIDER_PLUGIN.forwardResponses(providerPluginContext(), req, res, bodyText);
}

function modelsResponse() {
  return {
    object: "list",
    data: MODELS.map((model) => ({
      id: model.id,
      object: "model",
      created: 0,
      owned_by: "openai-codex",
    })),
  };
}

function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }

      if (url.pathname === "/healthz") {
        json(res, 200, await PROVIDER_PLUGIN.health(providerPluginContext()));
        return;
      }

      if ((url.pathname === "/v1/models" || url.pathname === "/models") && req.method === "GET") {
        json(res, 200, modelsResponse());
        return;
      }

      const isCompletionsPath =
        url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions";
      const isResponsesPath = url.pathname === "/v1/responses" || url.pathname === "/responses";
      if ((isResponsesPath || isCompletionsPath) && req.method === "POST") {
        if (!requireBridgeAuth(req, BRIDGE_KEY)) {
          json(res, 401, { error: { message: "Unauthorized", type: "unauthorized" } });
          return;
        }
        const bodyText = await readRequestBody(req);
        if (isCompletionsPath) {
          await forwardChatCompletions(req, res, bodyText);
        } else {
          await forwardResponses(req, res, bodyText);
        }
        return;
      }

      if (isCompletionsPath || isResponsesPath) {
        json(res, 405, { error: { message: "Method not allowed", type: "method_not_allowed" } });
        return;
      }

      json(res, 404, { error: { message: `Unknown route: ${url.pathname}`, type: "not_found" } });
    } catch (error: unknown) {
      json(res, 500, { error: { message: error instanceof Error ? error.message : String(error), type: "bridge_error" } });
    }
  });

  process.on("SIGTERM", () => {
    void shutdownCursorAcpRuntimes().finally(() => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1500).unref();
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`${CLI_NAME} listening on http://${HOST}:${PORT}`);
    console.log(`provider base URL: ${BASE_URL}`);
    console.log(`wireApi: completions+responses`);
    console.log(`syncResponses: ${SYNC_RESPONSES} (legacy; response format follows request stream flag)`);
    console.log(`type: ${BACKEND}`);
  });
}

function ensureStateDir() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

function readPid() {
  if (!existsSync(PID_PATH)) return null;
  const raw = readFileSync(PID_PATH, "utf8").trim();
  const pid = Number(raw);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isPidRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removePidFile() {
  try {
    unlinkSync(PID_PATH);
  } catch {}
}

function allSubscriptionNames() {
  return Object.keys(subscriptionsFromConfig(CONFIG_FILE));
}

function requireSubscriptions() {
  const subscriptions = allSubscriptionNames();
  if (subscriptions.length === 0) throw new Error(`No subscriptions configured in ${CONFIG_PATH}`);
  return subscriptions;
}

function runSubscriptionCommand(subscriptionName: string, commandName: string) {
  const result = spawnSync(process.execPath, [process.argv[1], "--sub", subscriptionName, commandName], {
    stdio: "inherit",
    env: process.env,
  });
  if ((result.status ?? 1) !== 0) process.exitCode = result.status ?? 1;
}

function runSubscriptionCommandJson(subscriptionName: string, commandName: string) {
  const result = spawnSync(process.execPath, [process.argv[1], "--sub", subscriptionName, commandName], {
    encoding: "utf8",
    env: process.env,
  });
  if ((result.status ?? 1) !== 0) {
    return {
      ok: false,
      status: result.status ?? null,
      error: result.stderr || result.error?.message || result.stdout || "subscription command failed",
    };
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return {
      ok: false,
      status: result.status ?? null,
      error: "subscription command returned invalid JSON",
      stdout: result.stdout,
    };
  }
}

async function fetchJson(url: string): Promise<FetchJsonResult> {
  const response = await fetch(url);
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { ok: response.ok, status: response.status, body };
}

async function statusCommand() {
  if (!SUB_NAME) {
    const statuses: Record<string, unknown> = {};
    for (const subscription of requireSubscriptions()) {
      statuses[subscription] = runSubscriptionCommandJson(subscription, "status");
    }
    console.log(JSON.stringify({ subscriptions: statuses }, null, 2));
    return;
  }

  const pid = readPid();
  const pidRunning = pid ? isPidRunning(pid) : false;
  let health = null;
  try {
    health = await fetchJson(HEALTH_URL);
  } catch {}

  const running = Boolean(pidRunning || health?.ok);
  const pluginStatusFields = PROVIDER_PLUGIN.statusFields(providerPluginContext());
  console.log(JSON.stringify({
    running,
    subscription: SUB_NAME || null,
    pid: pidRunning ? pid : null,
    base_url: BASE_URL,
    wire_api: "completions+responses",
    sync_responses: SYNC_RESPONSES,
    type: BACKEND,
    default_model: DEFAULT_MODEL,
    ...pluginStatusFields,
    health: health?.body || null,
    pid_path: PID_PATH,
    log_path: LOG_PATH,
  }, null, 2));
}

function runProbe(
  command: string,
  args: string[] = [],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeoutMs || 3000,
    env: options.env || process.env,
  });
  return {
    ok: result.status === 0,
    status: result.status ?? null,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
    error: result.error ? result.error.message : null,
  };
}

function commandProbe(
  command: string,
  args: string[] = ["--version"],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
) {
  const result = runProbe(command, args, options);
  return {
    available: !result.error,
    ok: result.ok,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  };
}

function providerPluginContext(): ProviderPluginContext {
  return {
    backend: BACKEND,
    providerName: PROVIDER_NAME,
    defaultModel: DEFAULT_MODEL,
    usePiWrapper: USE_PI_WRAPPER,
    piRuntimeDir: PI_RUNTIME_DIR,
    piTransport: PI_TRANSPORT,
    cursorAcpCommand: CURSOR_ACP_COMMAND,
    cursorWorkspace: CURSOR_WORKSPACE,
    cursorModel: CURSOR_MODEL,
    commandProbe,
    makeCursorRuntimeEnv,
    makeCursorProbeEnv,
    cursorAbout,
    cursorAuthDoctor,
    codexAuthDoctor,
    loadCodexAuth,
    loginCursor,
    loginCodex,
    logoutCursor,
    logoutCodex,
    fetchCursorModelSnapshot: () => fetchCursorModelSnapshot(),
    fetchCodexModelSnapshot,
    forwardResponsesCursorAcp,
    forwardResponsesPi,
    forwardResponsesRaw,
  };
}

function codexAuthDoctor() {
  const details: {
    path: string;
    exists: boolean;
    accessTokenPresent: boolean;
    refreshTokenPresent: boolean;
    accountIdPresent: boolean;
    expiresAt: string | null;
    expiresInSeconds: number | null;
    error: string | null;
  } = {
    path: AUTH_PATH,
    exists: existsSync(AUTH_PATH),
    accessTokenPresent: false,
    refreshTokenPresent: false,
    accountIdPresent: false,
    expiresAt: null,
    expiresInSeconds: null,
    error: null,
  };
  if (!details.exists) return details;
  try {
    const auth = readJson<CodexAuthFile>(AUTH_PATH);
    const accessToken = auth?.tokens?.access_token;
    const refreshToken = auth?.tokens?.refresh_token;
    details.accessTokenPresent = typeof accessToken === "string" && accessToken.length > 0;
    details.refreshTokenPresent = typeof refreshToken === "string" && refreshToken.length > 0;
    try {
      details.accountIdPresent = Boolean(details.accessTokenPresent && accessToken && extractAccountId(accessToken, auth));
    } catch {}
    const payload = typeof accessToken === "string" ? decodeJwtPayload(accessToken) : null;
    if (payload && typeof payload.exp === "number") {
      details.expiresAt = new Date(payload.exp * 1000).toISOString();
      details.expiresInSeconds = Math.floor(payload.exp - Date.now() / 1000);
    }
  } catch (error: unknown) {
    details.error = error instanceof Error ? error.message : String(error);
  }
  return details;
}

function cursorAuthDoctor() {
  const token = secretDoctorEntry(
    SECRETS_DIR,
    SecretName.CURSOR_AUTH_TOKEN,
    envKeysForSub("CURSOR_AUTH_TOKEN", ["SUB_BRIDGE_CURSOR_AUTH_TOKEN", "CURSOR_AUTH_TOKEN"]),
  );
  return {
    dir: SECRETS_DIR,
    vaultPath: join(SECRETS_DIR, "vault.enc"),
    tokenConfigured: token.configured,
    tokenSource: token.source,
  };
}

function secretsDoctor() {
  return {
    dir: SECRETS_DIR,
    vaultPath: join(SECRETS_DIR, "vault.enc"),
    stored: listStoredSecrets(SECRETS_DIR),
    codexClientId: secretDoctorEntry(
      SECRETS_DIR,
      SecretName.CODEX_CLIENT_ID,
      envKeysForSub("CODEX_CLIENT_ID", ["SUB_BRIDGE_CODEX_CLIENT_ID", "CODEX_CLIENT_ID"]),
    ),
    bridgeKey: secretDoctorEntry(
      SECRETS_DIR,
      SecretName.BRIDGE_KEY,
      envKeysForSub("KEY", ["SUB_BRIDGE_KEY", "CODEXSUB_BRIDGE_KEY"]),
    ),
    cursorAuthToken: secretDoctorEntry(
      SECRETS_DIR,
      SecretName.CURSOR_AUTH_TOKEN,
      envKeysForSub("CURSOR_AUTH_TOKEN", ["SUB_BRIDGE_CURSOR_AUTH_TOKEN", "CURSOR_AUTH_TOKEN"]),
    ),
  };
}

function secretsCommand(args: string[]) {
  const action = args[0];
  if (action === "list") {
    console.log(JSON.stringify({ dir: SECRETS_DIR, secrets: listStoredSecrets(SECRETS_DIR) }, null, 2));
    return;
  }
  if (action === "set") {
    const name = String(args[1] || "").trim();
    const value = args.slice(2).join(" ").trim();
    if (!name || !value) throw new Error("Usage: sub-bridge secrets set <name> <value>");
    if (!isSecretNameValue(name)) {
      throw new Error(`Unknown secret ${name}. Allowed: ${Object.values(SecretName).join(", ")}`);
    }
    saveSecret(SECRETS_DIR, name, value);
    console.log(`stored encrypted secret ${name} in ${SECRETS_DIR}`);
    return;
  }
  if (action === "unset") {
    const name = String(args[1] || "").trim();
    if (!name) throw new Error("Usage: sub-bridge secrets unset <name>");
    if (!isSecretNameValue(name)) {
      throw new Error(`Unknown secret ${name}. Allowed: ${Object.values(SecretName).join(", ")}`);
    }
    deleteSecret(SECRETS_DIR, name);
    console.log(`removed secret ${name} from ${SECRETS_DIR}`);
    return;
  }
  throw new Error("Usage: sub-bridge secrets <list|set|unset> ...");
}

function launchdDoctor() {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const manager = commandProbe("launchctl", ["managername"]);
  const gui = uid === null ? null : runProbe("launchctl", ["print", `gui/${uid}`], { timeoutMs: 3000 });
  const subscriptionLabel = SUB_NAME ? `com.sub-bridge.${slug(SUB_NAME)}` : null;
  const subscription = subscriptionLabel && uid !== null ? runProbe("launchctl", ["print", `gui/${uid}/${subscriptionLabel}`]) : null;
  return {
    uid,
    manager: manager.stdout || null,
    available: manager.available,
    guiSessionAvailable: Boolean(gui?.ok),
    subscriptionLabel,
    subscriptionLoaded: subscription ? subscription.ok : null,
    message: subscription && !subscription.ok ? subscription.stderr || subscription.error : null,
  };
}

function copilotDoctor(): CopilotDoctorDetails {
  const details: CopilotDoctorDetails = {
    dbPath: COPILOT_DB,
    exists: existsSync(COPILOT_DB),
    sqlite3: commandProbe("sqlite3", ["--version"]),
    providerId: PROVIDER_ID,
    extension: {
      name: COPILOT_EXTENSION_NAME,
      dir: COPILOT_EXTENSION_DIR,
      entry: join(COPILOT_EXTENSION_DIR, "extension.mjs"),
      exists: existsSync(join(COPILOT_EXTENSION_DIR, "extension.mjs")),
    },
    provider: null,
    modelCount: null,
    error: null,
  };
  if (!details.sqlite3.available || !details.exists) return details;

  const providerSql = `select id, name, base_url, wire_api from model_providers where id=${sqlQuote(PROVIDER_ID)};`;
  const providerResult = runProbe("sqlite3", ["-separator", "\t", COPILOT_DB, providerSql]);
  if (!providerResult.ok) {
    details.error = providerResult.stderr || providerResult.error || null;
    return details;
  }
  const [id, name, baseUrl, wireApi] = providerResult.stdout.split("\t");
  if (id) {
    details.provider = { id, name, baseUrl, wireApi };
  }

  const countSql = `select count(*) from provider_models where provider_id=${sqlQuote(PROVIDER_ID)};`;
  const countResult = runProbe("sqlite3", [COPILOT_DB, countSql]);
  if (countResult.ok && countResult.stdout) {
    details.modelCount = Number(countResult.stdout);
  }
  return details;
}

async function doctorCommand() {
  const pid = readPid();
  const pidRunning = pid ? isPidRunning(pid) : false;
  let health: FetchJsonResult | null = null;
  try {
    health = await fetchJson(HEALTH_URL);
  } catch (error: unknown) {
    health = { ok: false, status: null, body: null, error: error instanceof Error ? error.message : String(error) };
  }

  const providerDoctor = PROVIDER_PLUGIN.doctor(providerPluginContext()) as {
    tools: Record<string, unknown>;
    auth: Record<string, unknown>;
  };
  console.log(JSON.stringify({
    subscription: SUB_NAME || null,
    configPath: CONFIG_PATH,
    effective: effectiveConfig(),
    runtime: {
      pid: pidRunning ? pid : null,
      pidPath: PID_PATH,
      logPath: LOG_PATH,
      healthUrl: HEALTH_URL,
      healthStatus: health?.status ?? null,
      health: health?.body || null,
      healthError: health.error ?? null,
    },
    tools: {
      node: { version: process.version },
      ...providerDoctor.tools,
      sqlite3: commandProbe("sqlite3", ["--version"]),
    },
    auth: providerDoctor.auth,
    secrets: secretsDoctor(),
    macos: {
      launchd: launchdDoctor(),
    },
    copilot: copilotDoctor(),
  }, null, 2));
}

async function startCommand() {
  if (!SUB_NAME) {
    for (const subscription of requireSubscriptions()) {
      runSubscriptionCommand(subscription, "start");
    }
    return;
  }

  ensureStateDir();
  const pid = readPid();
  if (pid && isPidRunning(pid)) {
    console.log(`already running pid=${pid}`);
    return;
  }

  removePidFile();
  const out = openSync(LOG_PATH, "a", 0o600);
  const childArgs = SUB_NAME ? [process.argv[1], "--sub", SUB_NAME, "serve"] : [process.argv[1], "serve"];
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.unref();
  writeFileSync(PID_PATH, `${child.pid}\n`, { mode: 0o600 });
  console.log(`started pid=${child.pid}`);
  console.log(`base_url=${BASE_URL}`);
  console.log(`type=${BACKEND}`);
  console.log(`log=${LOG_PATH}`);
}

async function enableCommand() {
  if (!SUB_NAME) {
    for (const subscription of requireSubscriptions()) {
      runSubscriptionCommand(subscription, "enable");
    }
    return;
  }

  await startCommand();
  console.log(`enabled subscription=${SUB_NAME || "default"}`);
}

function stopCommand() {
  if (!SUB_NAME) {
    for (const subscription of requireSubscriptions()) {
      runSubscriptionCommand(subscription, "stop");
    }
    return;
  }

  const pid = readPid();
  if (!pid) {
    console.log("stopped");
    return;
  }
  if (!isPidRunning(pid)) {
    removePidFile();
    console.log("stopped");
    return;
  }

  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isPidRunning(pid)) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  if (isPidRunning(pid)) {
    console.error(`still running pid=${pid}`);
    process.exitCode = 1;
    return;
  }
  removePidFile();
  console.log(`stopped pid=${pid}`);
}

function loginCursor() {
  const token = envValue(...envKeysForSub("CURSOR_AUTH_TOKEN", ["SUB_BRIDGE_CURSOR_AUTH_TOKEN", "CURSOR_AUTH_TOKEN"]));
  if (!token || !String(token).trim()) {
    throw new Error("Set SUB_BRIDGE_CURSOR_AUTH_TOKEN or CURSOR_AUTH_TOKEN, then run cursor login again.");
  }
  saveSecret(SECRETS_DIR, SecretName.CURSOR_AUTH_TOKEN, token);
  console.log(`stored encrypted cursor auth token in secrets vault (${SECRETS_DIR})`);
}

function loginCodex() {
  const result = spawnSync("codex", ["login"], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
}

function loginCommand() {
  return PROVIDER_PLUGIN.login(providerPluginContext());
}

function logoutCursor() {
  removeCursorAuthToken();
  console.log(`removed cursor auth token from secrets vault (${SECRETS_DIR})`);
}

function logoutCodex() {
  const result = spawnSync("codex", ["logout"], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
}

function logoutCommand() {
  stopCommand();
  return PROVIDER_PLUGIN.logout(providerPluginContext());
}

function modelsCommand() {
  console.log(JSON.stringify(modelsResponse(), null, 2));
}

function modelsFromJson(value: unknown) {
  const record = isPlainObject(value) ? value : {};
  const source = Array.isArray(value)
    ? value
    : Array.isArray(record.data)
      ? record.data
      : Array.isArray(record.models)
        ? record.models
        : [];
  return normalizeModelList(
    source.map((model: unknown) => {
      if (typeof model === "string") return { id: model, displayName: `SubBridge ${model}` };
      const entry = isPlainObject(model) ? model : {};
      const id = entry.id || entry.modelId || entry.name;
      return {
        ...entry,
        id,
        displayName: entry.displayName || entry.name || id,
        contextWindow: entry.contextWindow || entry.max_prompt_tokens || entry.maxPromptTokens,
        maxTokens: entry.maxTokens || entry.max_output_tokens || entry.maxOutputTokens,
      };
    }),
  );
}

function modelsFromText(text: string) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^no models available/i.test(line))
    .filter((line) => !/^usage:/i.test(line));
  return normalizeModelList(lines.map((line) => {
    const clean = line.replace(/^[*-]\s*/, "");
    const id = clean.split(/\s{2,}|\t/)[0].trim();
    return { id, displayName: clean };
  }));
}

function parseModelCommandOutput(text: string) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return [];
  try {
    return modelsFromJson(JSON.parse(trimmed));
  } catch {
    return modelsFromText(trimmed);
  }
}

function mergeFetchedModels(fetchedModels: unknown, configuredModels: unknown) {
  const configuredById = new Map(normalizeModelList(configuredModels).map((model) => [model.id, model]));
  const optionKeys = [
    "reasoningEffort",
    "fastMode",
    "thinking",
    "cursorContextWindow",
    "cursorContext",
    "contextOption",
    "cursorModel",
  ] as const;
  return normalizeModelList(fetchedModels).map((model) => {
    const configured =
      configuredById.get(model.id) ||
      configuredById.get(stripCursorParameterizedSuffix(model.id));
    if (!configured) return model;
    const merged: ModelEntry = { ...model };
    for (const key of optionKeys) {
      const configuredValue = configured[key];
      if (configuredValue !== undefined) {
        (merged as Record<string, unknown>)[key] = configuredValue;
      }
    }
    return merged;
  });
}

function mergeCursorDiscoveredModels(primaryModels: unknown, additionalModels: unknown) {
  const seen = new Set();
  const merged = [];
  for (const model of [...normalizeModelList(primaryModels), ...normalizeModelList(additionalModels)]) {
    const key = model.id.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(model);
  }
  return merged;
}

function mergeCursorCliModelSnapshot(snapshot: {
  source: string;
  models: ModelEntry[];
  offline?: boolean;
  error?: string | null;
}) {
  const cliSnapshot = fetchCursorModelCommandSnapshot();
  if (cliSnapshot.source === "builtin") return snapshot;
  return {
    ...snapshot,
    source: `${snapshot.source}+${cliSnapshot.source}`,
    models: mergeCursorDiscoveredModels(snapshot.models, cliSnapshot.models),
  };
}

async function fetchCursorModelSnapshot(): Promise<{
  models: ModelEntry[];
  source: string;
  offline?: boolean;
  error?: string | null;
}> {
  if (OFFLINE_DISCOVERY) {
    return { models: BUILTIN_MODELS, source: "builtin", offline: true };
  }

  const fetchViaAcp = async (env: NodeJS.ProcessEnv, source: string) => {
    const models = normalizeModelList(await fetchCursorAcpModels({
      command: CURSOR_ACP_COMMAND,
      apiEndpoint: CURSOR_API_ENDPOINT || undefined,
      workspace: CURSOR_WORKSPACE,
      env,
      timeoutMs: CURSOR_ACP_TIMEOUT_MS,
      onStderr: () => {},
      onProtocolError: () => {},
    }));
    return models.length > 0 ? { models, source } : null;
  };

  try {
    const snapshot = await fetchViaAcp(makeBridgeCursorEnv({ forceCi: true }), "cursor-acp-local-auth");
    if (snapshot) return mergeCursorCliModelSnapshot(snapshot);
  } catch {}

  try {
    const snapshot = await fetchViaAcp(makeCursorEnv({ forceCi: true }), "cursor-acp-agent-auth");
    if (snapshot) return mergeCursorCliModelSnapshot(snapshot);
  } catch (error: unknown) {
    const fallback = fetchCursorModelCommandSnapshot();
    if (fallback.source !== "builtin") return fallback;
    return {
      ...fallback,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return fetchCursorModelCommandSnapshot();
}

function fetchCursorModelCommandSnapshot() {
  const args = [
    ...(CURSOR_API_ENDPOINT ? ["-e", CURSOR_API_ENDPOINT] : []),
    "models",
  ];
  const result = spawnSync(CURSOR_ACP_COMMAND, args, {
    encoding: "utf8",
    timeout: 8000,
    env: makeCursorRuntimeEnv({ forceCi: true }),
  });
  const models = normalizeModelList(parseCursorCliModelList(result.stdout));
  if (result.status === 0 && models.length > 0) {
    return { models, source: "cursor-agent" };
  }
  return {
    models: BUILTIN_MODELS,
    source: "builtin",
    error: result.stderr || result.stdout || result.error?.message || null,
  };
}

async function fetchCodexModelSnapshot() {
  if (OFFLINE_DISCOVERY) {
    return { models: BUILTIN_MODELS, source: "builtin", offline: true };
  }

  try {
    const runtime = await loadPiRuntime();
    const models = normalizeModelList(Array.from(runtime.models.values()).map((model) => ({
      id: model.id,
      displayName: model.displayName || model.name || `SubBridge ${model.id}`,
      contextWindow: model.contextWindow || model.context_window,
      maxTokens: model.maxTokens || model.max_tokens,
    })));
    if (models.length > 0) return { models, source: "pi-runtime" };
  } catch (error: unknown) {
    return {
      models: BUILTIN_MODELS,
      source: "builtin",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return { models: BUILTIN_MODELS, source: "builtin" };
}

async function fetchModelSnapshot() {
  const snapshot = await PROVIDER_PLUGIN.fetchModelSnapshot(providerPluginContext());
  return {
    models: mergeFetchedModels(snapshot.models, CONFIG.models),
  };
}

const CONFIG_SCHEMA = new Map([
  ["$schema", "string"],
  ["version", "number"],
  ["host", "string"],
  ["port", "number"],
  ["models", "json"],
  ["modelGroups", "json"],
  ["type", "string"],
  ["providerId", "string"],
  ["providerName", "string"],
]);

function parseConfigInput(key: string, value: string) {
  const type = CONFIG_SCHEMA.get(key);
  if (!type) throw new Error(`Unknown config key: ${key}`);
  if (type === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`Config key ${key} requires a number`);
    return number;
  }
  if (type === "boolean") {
    const normalized = String(value).toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    throw new Error(`Config key ${key} requires a boolean`);
  }
  if (type === "json") {
    try {
      return JSON.parse(value);
    } catch (error: unknown) {
      throw new Error(`Config key ${key} requires JSON`);
    }
  }
  return String(value);
}

function configTemplate() {
  return {
    type: BACKEND,
    host: HOST,
    port: PORT,
    providerId: PROVIDER_ID,
    providerName: PROVIDER_NAME,
    models: MODELS,
  };
}

function redactedConfig(value: unknown) {
  const copy = JSON.parse(JSON.stringify(value || {}));
  return copy;
}

function effectiveConfig() {
  return {
    subscription: SUB_NAME || null,
    type: BACKEND,
    host: HOST,
    port: PORT,
    providerId: PROVIDER_ID,
    providerName: PROVIDER_NAME,
    defaultModel: DEFAULT_MODEL,
    defaultReasoningEffort: REASONING_EFFORT,
    modelGroups: PROVIDER_PLUGIN.id === "cursor-acp" ? normalizeModelGroupsConfig(CONFIG.modelGroups) : null,
    models: MODELS,
    baseUrl: BASE_URL,
  };
}

function cursorModelsForGroupControl() {
  if (PROVIDER_PLUGIN.id !== "cursor-acp") throw new Error("Model groups require a cursor-acp subscription");
  const configured = normalizeModelList(CONFIG.models);
  return mergeCursorModelVariantsWithBaseControls(configured.length > 0 ? configured : BUILTIN_MODELS);
}

function cursorGroupSummary() {
  return summarizeCursorModelGroups(cursorModelsForGroupControl(), CONFIG.modelGroups);
}

function resolveCursorModelGroupId(value: string) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Usage: sub-bridge config group <enable|disable|only|preset|reset> <group...>");
  const groups = cursorGroupSummary();
  const normalized = slug(raw);
  const matches = groups.filter((group) =>
    group.id === raw ||
    group.id === normalized ||
    group.id.endsWith(`:${normalized}`) ||
    slug(group.name) === normalized,
  );
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) {
    throw new Error(`Ambiguous model group '${raw}': ${matches.map((group) => group.id).join(", ")}`);
  }
  throw new Error(`Unknown model group: ${raw}`);
}

function resolveCursorModelGroupIds(values: string[]) {
  const groupIds = values.map(resolveCursorModelGroupId);
  return Array.from(new Set(groupIds));
}

function writeCursorModelGroupState(groupId: string, enabled: boolean) {
  const current = normalizeModelGroupsConfig(CONFIG.modelGroups);
  const disabled = new Set(current.disabled);
  const only = new Set(current.only);
  if (only.size > 0) {
    if (enabled) {
      disabled.delete(groupId);
      only.add(groupId);
    } else if (only.has(groupId)) {
      only.delete(groupId);
    } else {
      disabled.add(groupId);
    }
    writeActiveConfigValue("modelGroups", {
      disabled: Array.from(disabled).sort(),
      only: Array.from(only),
      preset: current.preset,
    });
    return;
  }
  if (enabled) disabled.delete(groupId);
  else disabled.add(groupId);
  writeActiveConfigValue("modelGroups", {
    disabled: Array.from(disabled).sort(),
    only: Array.from(only),
    preset: current.preset,
  });
}

function writeCursorModelGroupOnly(groupIds: string[]) {
  const current = normalizeModelGroupsConfig(CONFIG.modelGroups);
  writeActiveConfigValue("modelGroups", {
    disabled: [],
    only: Array.from(new Set(groupIds)),
    preset: current.preset,
  });
}

function writeCursorModelGroupPreset(preset: string) {
  const current = normalizeModelGroupsConfig(CONFIG.modelGroups);
  const normalized = String(preset || "").trim().toLowerCase();
  if (!["latest", "off", "none", "reset"].includes(normalized)) {
    throw new Error("Usage: sub-bridge config group preset <latest|off>");
  }
  writeActiveConfigValue("modelGroups", {
    disabled: current.disabled,
    only: current.only,
    preset: normalized === "latest" ? "latest" : "",
  });
}

function resetCursorModelGroups() {
  writeActiveConfigValue("modelGroups", { disabled: [], only: [], preset: "" });
}

function writeConfigFile(config: ConfigDocument) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  const tempPath = `${CONFIG_PATH}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tempPath, CONFIG_PATH);
}

function writeActiveConfigValue(key: string, value: unknown) {
  const configKey = key;
  if (!SUB_NAME) {
    if (configKey === "$schema" || configKey === "version") {
      writeConfigFile({ ...configDocument(), [configKey]: value } as ConfigDocument);
      return;
    }
    throw new Error(`Use --sub <name> for config set ${configKey}`);
  }
  const subscriptions = subscriptionsFromConfig(CONFIG_FILE);
  const subscriptionConfig =
    subscriptions[SUB_NAME] && typeof subscriptions[SUB_NAME] === "object" && !Array.isArray(subscriptions[SUB_NAME])
      ? subscriptions[SUB_NAME]
      : configTemplate();
  subscriptions[SUB_NAME] = normalizeSubscriptionConfig({ ...configTemplate(), ...subscriptionConfig, [configKey]: value });
  writeConfigFile(configDocument(subscriptions));
}

function unsetActiveConfigValue(key: string) {
  const configKey = key;
  if (!SUB_NAME) {
    if (configKey === "$schema" || configKey === "version") {
      const nextConfig = { ...configDocument() } as ConfigDocument & Record<string, unknown>;
      delete nextConfig[configKey];
      writeConfigFile(nextConfig as ConfigDocument);
      return;
    }
    throw new Error(`Use --sub <name> for config unset ${configKey}`);
  }
  const subscriptions = subscriptionsFromConfig(CONFIG_FILE);
  const subscriptionConfig: SubscriptionConfig =
    subscriptions[SUB_NAME] && typeof subscriptions[SUB_NAME] === "object" && !Array.isArray(subscriptions[SUB_NAME])
      ? { ...subscriptions[SUB_NAME] }
      : {};
  delete (subscriptionConfig as Record<string, unknown>)[configKey];
  subscriptions[SUB_NAME] = normalizeSubscriptionConfig(subscriptionConfig);
  writeConfigFile(configDocument(subscriptions));
}

function writeSubscriptionConfig(subscriptionName: string, subscriptionConfig: SubscriptionConfig) {
  const subscriptions = subscriptionsFromConfig(CONFIG_FILE);
  subscriptions[subscriptionName] = normalizeSubscriptionConfig(subscriptionConfig);
  writeConfigFile(configDocument(subscriptions));
}

async function configCommand(args: string[]) {
  const action = args[0] || "show";
  if (action === "path") {
    console.log(CONFIG_PATH);
    return;
  }
  if (action === "show") {
    const normalizedFile = configDocument();
    console.log(JSON.stringify({
      configPath: CONFIG_PATH,
      subscription: SUB_NAME || null,
      exists: existsSync(CONFIG_PATH),
      file: redactedConfig(normalizedFile),
      active: redactedConfig(CONFIG),
      effective: SUB_NAME ? effectiveConfig() : null,
    }, null, 2));
    return;
  }
  if (action === "init") {
    if (!SUB_NAME) {
      writeConfigFile(configDocument());
      console.log(`wrote ${CONFIG_PATH}`);
      return;
    }
    const nextConfig = { ...configTemplate(), ...CONFIG, ...(await fetchModelSnapshot()) };
    if (SUB_NAME) {
      writeSubscriptionConfig(SUB_NAME, nextConfig);
    }
    console.log(`wrote ${CONFIG_PATH}`);
    return;
  }
  if (action === "get") {
    const key = args[1];
    if (!key || !CONFIG_SCHEMA.has(key)) throw new Error(`Unknown config key: ${key}`);
    if (!SUB_NAME && key !== "$schema" && key !== "version") {
      throw new Error(`Use --sub <name> for config get ${key}`);
    }
    if (key === "$schema" || key === "version") {
      console.log(JSON.stringify(configDocument()[key as "$schema" | "version"], null, 2));
      return;
    }
    const effective = effectiveConfig() as Record<string, unknown>;
    const value = effective[key] ?? (CONFIG as Record<string, unknown>)[key] ?? null;
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (action === "groups") {
    console.log(JSON.stringify(cursorGroupSummary(), null, 2));
    return;
  }
  if (action === "group") {
    const verb = args[1];
    if (verb === "enable") {
      const groupId = resolveCursorModelGroupId(args[2]);
      writeCursorModelGroupState(groupId, true);
      console.log(`enabled model group ${groupId}`);
      return;
    }
    if (verb === "disable") {
      const groupId = resolveCursorModelGroupId(args[2]);
      writeCursorModelGroupState(groupId, false);
      console.log(`disabled model group ${groupId}`);
      return;
    }
    if (verb === "only") {
      const groupIds = resolveCursorModelGroupIds(args.slice(2));
      if (groupIds.length === 0) throw new Error("Usage: sub-bridge config group only <group...>");
      writeCursorModelGroupOnly(groupIds);
      console.log(`selected model groups ${groupIds.join(", ")}`);
      return;
    }
    if (verb === "preset") {
      writeCursorModelGroupPreset(args[2]);
      console.log(`set model group preset ${String(args[2] || "").trim().toLowerCase() || "off"}`);
      return;
    }
    if (verb === "reset") {
      resetCursorModelGroups();
      console.log("reset model groups");
      return;
    }
    throw new Error("Usage: sub-bridge config group <enable|disable|only|preset|reset> <group...>");
  }
  if (action === "set") {
    const [key, ...rest] = args.slice(1);
    if (!key || rest.length === 0) throw new Error("Usage: sub-bridge config set <key> <value>");
    const value = parseConfigInput(key, rest.join(" "));
    writeActiveConfigValue(key, value);
    console.log(`set ${key}`);
    return;
  }
  if (action === "unset") {
    const key = args[1];
    if (!CONFIG_SCHEMA.has(key)) throw new Error(`Unknown config key: ${key}`);
    unsetActiveConfigValue(key);
    console.log(`unset ${key}`);
    return;
  }
  throw new Error(`Unknown config command: ${action}`);
}

function extractOutputTextFromSse(text: string) {
  let doneText = "";
  let deltaText = "";
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let payload = trimmed;
    if (payload.startsWith("data: ")) payload = payload.slice(6).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const event = JSON.parse(payload);
      if (event?.type === "response.output_text.done" && typeof event.text === "string") {
        doneText = event.text;
      } else if (event?.type === "response.output_text.delta" && typeof event.delta === "string") {
        deltaText += event.delta;
      }
    } catch {}
  }
  return doneText || deltaText;
}

async function checkCommand() {
  const body = JSON.stringify({
    model: DEFAULT_MODEL,
    store: false,
    stream: true,
    instructions: "Reply with pong.",
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "ping" }],
      },
    ],
  });

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (BRIDGE_KEY) headers.authorization = `Bearer ${BRIDGE_KEY}`;
  const response = await fetch(`${BASE_URL}/responses`, { method: "POST", headers, body });
  const text = await response.text();
  const outputText = extractOutputTextFromSse(text);
  console.log(JSON.stringify({
    ok: response.ok,
    status: response.status,
    model: DEFAULT_MODEL,
    output: outputText || null,
    raw_prefix: outputText ? undefined : text.slice(0, 1000),
  }, null, 2));
}

function sqlQuote(value: unknown) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

const SUBBRIDGE_COPILOT_PROVIDER_PREFIX = "subbridge-";

function repairCopilotWireApiSql({ providerId = null } = {}) {
  const providerFilter = providerId
    ? `id = ${sqlQuote(providerId)}`
    : `id like ${sqlQuote(`${SUBBRIDGE_COPILOT_PROVIDER_PREFIX}%`)}`;
  return `
update model_providers
set wire_api = 'completions',
    settings_json = json_set(COALESCE(settings_json, '{}'), '$.wireApi', 'completions'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
where ${providerFilter};

update provider_models
set wire_api_override = null,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
where provider_id in (select id from model_providers where ${providerFilter});
`;
}

function repairCopilotWireApi({ providerId = null } = {}) {
  if (!existsSync(COPILOT_DB)) {
    throw new Error(`Copilot database not found: ${COPILOT_DB}`);
  }
  execFileSync("sqlite3", [COPILOT_DB, repairCopilotWireApiSql({ providerId })], { stdio: "inherit" });
}

const COPILOT_CURSOR_TOOL_KINDS = ["execute", "search", "read", "edit", "delete", "move", "fetch", "tool", "plan", "question"];

function copilotExtensionSource() {
  return `import { joinSession } from "@github/copilot-sdk/extension";

const toolKinds = ${JSON.stringify(COPILOT_CURSOR_TOOL_KINDS)};

function formatToolResult(args) {
  const input = args && typeof args === "object" ? args : {};
  const lines = [];
  const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : "SubBridge Cursor tool";
  lines.push(title);
  if (typeof input.status === "string" && input.status) lines.push("status: " + input.status);
  if (typeof input.kind === "string" && input.kind) lines.push("kind: " + input.kind);
  if (typeof input.detail === "string" && input.detail) lines.push("detail: " + input.detail);
  if (typeof input.command === "string" && input.command) lines.push("command: " + input.command);
  if (Array.isArray(input.steps) && input.steps.length > 0) {
    lines.push("steps:");
    for (const step of input.steps) {
      const label = typeof step?.step === "string" ? step.step : "Step";
      const status = typeof step?.status === "string" ? step.status : "pending";
      lines.push("- [" + status + "] " + label);
    }
  }
  if (typeof input.planMarkdown === "string" && input.planMarkdown.trim()) {
    lines.push("plan:");
    lines.push(input.planMarkdown.trim());
  }
  if (Array.isArray(input.questions) && input.questions.length > 0) {
    lines.push("questions:");
    for (const question of input.questions) {
      const prompt = typeof question?.prompt === "string" ? question.prompt : "Question";
      lines.push("- " + prompt);
    }
  }
  if (input.output !== undefined) lines.push("output: " + JSON.stringify(input.output));
  return lines.join("\\n");
}

function defineSubBridgeCursorTool(kind) {
  const descriptions = {
    plan: "Displays a Cursor plan or todo update forwarded by the SubBridge provider runtime.",
    question: "Displays a Cursor ask-question prompt forwarded by the SubBridge provider runtime.",
  };
  return {
    name: "subbridge_cursor_" + kind,
    description: descriptions[kind] || "Displays a Cursor ACP tool event that was executed by the SubBridge provider runtime.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        status: { type: "string" },
        kind: { type: "string" },
        detail: { type: "string" },
        command: { type: "string" },
        input: {},
        output: {},
        locations: {},
        steps: {},
        planMarkdown: { type: "string" },
        questions: {},
        answers: {},
        source: { type: "string" },
      },
      additionalProperties: true,
    },
    handler: async (args) => ({
      resultType: args?.status === "failed" ? "failure" : "success",
      textResultForLlm: formatToolResult(args),
    }),
  };
}

await joinSession({
  tools: toolKinds.map(defineSubBridgeCursorTool),
});
`;
}

function installCopilotExtension() {
  mkdirSync(COPILOT_EXTENSION_DIR, { recursive: true });
  const entry = join(COPILOT_EXTENSION_DIR, "extension.mjs");
  writeFileSync(entry, copilotExtensionSource(), { mode: 0o644 });
  console.log(`installed Copilot extension ${COPILOT_EXTENSION_NAME}`);
  console.log(`extension=${entry}`);
}

function installCopilot() {
  const baseUrl = `http://${HOST}:${PORT}/v1`;
  const backup = `${COPILOT_DB}.codexsub-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  execFileSync("sqlite3", [COPILOT_DB, `.backup ${sqlQuote(backup)}`], { stdio: "inherit" });

  const settingsJson = JSON.stringify({
    baseUrl,
    wireApi: "completions",
    azureApiVersion: null,
    authKind: "api_key",
    headers: {},
  });

  const providerSql = `
insert into model_providers
  (id, name, base_url, wire_api, azure_api_version, auth_kind, headers_json, type, settings_json)
values
  (${sqlQuote(PROVIDER_ID)}, ${sqlQuote(PROVIDER_NAME)}, ${sqlQuote(baseUrl)}, 'completions', null, 'api_key', '{}', 'custom', ${sqlQuote(settingsJson)})
on conflict(id) do update set
  name=excluded.name,
  base_url=excluded.base_url,
  wire_api='completions',
  azure_api_version=excluded.azure_api_version,
  auth_kind=excluded.auth_kind,
  headers_json=excluded.headers_json,
  type=excluded.type,
  settings_json=json_set(
    json_set(COALESCE(model_providers.settings_json, '{}'), '$.wireApi', 'completions'),
    '$.baseUrl', excluded.base_url
  ),
  updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
`;

  const deleteModelsSql = `delete from provider_models where provider_id=${sqlQuote(PROVIDER_ID)};`;

  const modelSql = MODELS.map((model) => {
    const id = `${PROVIDER_ID}/${model.id}`;
    return `
	insert into provider_models
	  (id, provider_id, model_id, wire_model, display_name, max_prompt_tokens, max_output_tokens, wire_api_override)
values
  (${sqlQuote(id)}, ${sqlQuote(PROVIDER_ID)}, ${sqlQuote(model.id)}, ${sqlQuote(model.id)}, ${sqlQuote(model.displayName)}, ${model.contextWindow}, ${model.maxTokens}, null)
on conflict(id) do update set
  provider_id=excluded.provider_id,
  model_id=excluded.model_id,
  wire_model=excluded.wire_model,
  display_name=excluded.display_name,
  max_prompt_tokens=excluded.max_prompt_tokens,
  max_output_tokens=excluded.max_output_tokens,
  wire_api_override=null,
  updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
`;
  }).join("\n");

  const sql = `begin;\n${providerSql}\n${deleteModelsSql}\n${modelSql}\ncommit;\n`;
  execFileSync("sqlite3", [COPILOT_DB, sql], { stdio: "inherit" });
  installCopilotExtension();
  console.log(`installed provider ${PROVIDER_NAME}`);
  console.log(`baseUrl=${baseUrl}`);
  console.log(`wireApi=completions`);
  console.log(`backup=${backup}`);
}

const TARGETS = [
  {
    id: "copilot",
    name: "GitHub Copilot",
    status: "supported",
    install: installCopilot,
  },
  {
    id: "cursor",
    name: "Cursor",
    status: "planned",
    install: () => {
      console.error("Cursor target is planned. Add its install adapter under the target registry before use.");
      process.exitCode = 1;
    },
  },
];

function targetsCommand() {
  console.log(JSON.stringify(TARGETS.map(({ id, name, status }) => ({ id, name, status })), null, 2));
}

function installTargetForSubscription(subscriptionName: string, targetId: string) {
  const result = spawnSync(process.execPath, [process.argv[1], "--sub", subscriptionName, "install", targetId], {
    stdio: "inherit",
    env: process.env,
  });
  if ((result.status ?? 1) !== 0) process.exitCode = result.status ?? 1;
}

function installTarget(targetId = "copilot") {
  if (targetId === "copilot" && !SUB_NAME) {
    const subscriptions = allSubscriptionNames();
    if (subscriptions.length === 0) throw new Error(`No subscriptions configured in ${CONFIG_PATH}`);
    console.log(`installing subscriptions: ${subscriptions.join(", ")}`);
    for (const subscription of subscriptions) installTargetForSubscription(subscription, targetId);
    if (existsSync(COPILOT_DB)) {
      repairCopilotWireApi();
      console.log("repaired Copilot wire_api=completions for all SubBridge providers");
    }
    return;
  }

  const target = TARGETS.find((item) => item.id === targetId);
  if (!target) {
    console.error(`Unknown target: ${targetId}`);
    targetsCommand();
    process.exitCode = 1;
    return;
  }
  target.install();
}

export async function runCli() {
  const args = GLOBAL_ARGS.args;
  const command = args[0] || "status";
  if (command === "serve") {
    if (!SUB_NAME) throw new Error("Use --sub <name> serve");
    startServer();
  } else if (command === "start") await startCommand();
  else if (command === "stop") stopCommand();
  else if (command === "status") await statusCommand();
  else if (command === "enable") await enableCommand();
  else if (command === "login") loginCommand();
  else if (command === "logout") logoutCommand();
  else if (command === "doctor") await doctorCommand();
  else if (command === "check" || command === "probe") await checkCommand();
  else if (command === "models") modelsCommand();
  else if (command === "config") await configCommand(args.slice(1));
  else if (command === "secrets") secretsCommand(args.slice(1));
  else if (command === "targets") targetsCommand();
  else if (command === "install") installTarget(args[1]);
  else if (command === "install-copilot") installTarget("copilot");
  else if (command === "help" || command === "--help" || command === "-h") usage(0);
  else usage(1);
}
