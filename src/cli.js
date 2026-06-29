#!/usr/bin/env node
import { createServer } from "node:http";
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
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { cursorAbout, fetchCursorAcpModels, makeCursorEnv, runCursorAcpTurn } from "./cursor-acp.js";
import { defaultCursorAcpCommand, makeCursorProbeEnv } from "./cursor-runtime.js";
import { errorMessage, isAbortLikeError, isRetryableTransientError } from "./errors.js";
import {
  defaultProviderId as defaultPluginProviderId,
  defaultProviderName as defaultPluginProviderName,
  defaultProviderPort,
  defaultProviderTypeForSub,
  providerPluginForType,
} from "./provider-plugins.js";
import {
  cursorOptionsFromModelEntry,
  filterCursorModelsByGroups,
  mergeCursorModelVariantsWithBaseControls,
  mergeCursorModelOptions,
  normalizeModelGroupsConfig,
  parseCursorCliModelList,
  summarizeCursorModelGroups,
  stripCursorParameterizedSuffix,
} from "./cursor-models.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_RESPONSES_PATH = "/codex/responses";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

const CLI_NAME = "sub-bridge";
const CONFIG_VERSION = 1;
const CONFIG_SCHEMA_URL = "https://raw.githubusercontent.com/alexzhang1030/sub-bridge/main/schemas/config.schema.json";

function envValue(...keys) {
  for (const key of keys) {
    if (process.env[key] !== undefined) return process.env[key];
  }
  return undefined;
}

function parseGlobalArgs(argv) {
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

function slug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function subEnvKey(suffix) {
  const name = slug(SUB_NAME).replace(/-/g, "_").toUpperCase();
  return name ? `SUB_BRIDGE_${name}_${suffix}` : "";
}

function envKeysForSub(suffix, fallbackKeys = []) {
  return [subEnvKey(suffix), ...fallbackKeys].filter(Boolean);
}

function defaultTypeForSub(subName) {
  return defaultProviderTypeForSub(subName);
}

function defaultPortForSub(subName, type) {
  return defaultProviderPort(subName, type);
}

function defaultProviderId(subName, type) {
  return defaultPluginProviderId(subName, type);
}

function defaultProviderName(subName, type) {
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

function readConfigFile(path = CONFIG_PATH) {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config file must contain a JSON object: ${path}`);
  }
  return parsed;
}

const CONFIG_FILE = readConfigFile();

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function normalizeSubscriptionConfig(subscription) {
  const next = {};
  if (!isPlainObject(subscription)) return next;
  for (const key of SUBSCRIPTION_CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(subscription, key)) next[key] = subscription[key];
  }
  return next;
}

function subscriptionsFromConfig(configFile) {
  const source = isPlainObject(configFile?.subscriptions) ? configFile.subscriptions : {};
  const subscriptions = {};
  for (const [name, subscription] of Object.entries(source)) {
    if (!isPlainObject(subscription)) continue;
    subscriptions[name] = normalizeSubscriptionConfig(subscription);
  }
  return subscriptions;
}

function configDocument(subscriptions = subscriptionsFromConfig(CONFIG_FILE)) {
  return {
    $schema: CONFIG_SCHEMA_URL,
    version: CONFIG_VERSION,
    subscriptions,
  };
}

function activeConfig(configFile, subName) {
  if (!subName) return {};
  const subscription = subscriptionsFromConfig(configFile)[subName];
  return normalizeSubscriptionConfig(subscription);
}

const CONFIG = activeConfig(CONFIG_FILE, SUB_NAME);

function configValue(key, envKeys, fallback) {
  const env = envValue(...envKeys);
  if (env !== undefined) return env;
  if (CONFIG[key] !== undefined) return CONFIG[key];
  return fallback;
}

function configNumber(key, envKeys, fallback) {
  const value = configValue(key, envKeys, fallback);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Invalid numeric config value for ${key}: ${value}`);
  return number;
}

function configBoolean(key, envKeys, fallback) {
  const value = configValue(key, envKeys, fallback);
  const normalized = String(value).toLowerCase();
  return !["0", "false", "no", "off"].includes(normalized);
}

const BACKEND = configValue("type", envKeysForSub("TYPE", ["SUB_BRIDGE_TYPE"]), defaultTypeForSub(SUB_NAME));
const PROVIDER_PLUGIN = providerPluginForType(BACKEND);
const AUTH_PATH =
  configValue(
    "authPath",
    envKeysForSub("AUTH_PATH", ["SUB_BRIDGE_AUTH_PATH", "CODEXSUB_AUTH_PATH"]),
    join(homedir(), ".codex", "auth.json"),
  );
const COPILOT_DB =
  configValue(
    "copilotDb",
    envKeysForSub("COPILOT_DB", ["SUB_BRIDGE_COPILOT_DB", "CODEXSUB_COPILOT_DB"]),
    join(homedir(), ".copilot", "data.db"),
  );
const COPILOT_EXTENSION_NAME = "sub-bridge-tools";
const COPILOT_EXTENSION_DIR =
  envValue("SUB_BRIDGE_COPILOT_EXTENSION_DIR") ||
  join(homedir(), ".copilot", "extensions", COPILOT_EXTENSION_NAME);
const HOST = configValue("host", envKeysForSub("HOST", ["SUB_BRIDGE_HOST", "CODEXSUB_HOST"]), "127.0.0.1");
const PORT = configNumber(
  "port",
  envKeysForSub("PORT", ["SUB_BRIDGE_PORT", "CODEXSUB_PORT"]),
  defaultPortForSub(SUB_NAME, BACKEND),
);
const DEFAULT_MODEL_OVERRIDE = envValue(...envKeysForSub("MODEL", ["SUB_BRIDGE_MODEL", "CODEXSUB_MODEL"]));
const BRIDGE_KEY = configValue("bridgeKey", envKeysForSub("KEY", ["SUB_BRIDGE_KEY", "CODEXSUB_BRIDGE_KEY"]), "");
const ORIGINATOR = configValue(
  "originator",
  envKeysForSub("ORIGINATOR", ["SUB_BRIDGE_ORIGINATOR", "CODEXSUB_ORIGINATOR"]),
  "pi",
);
const PROVIDER_ID = configValue(
  "providerId",
  envKeysForSub("PROVIDER_ID", ["SUB_BRIDGE_PROVIDER_ID", "CODEXSUB_PROVIDER_ID"]),
  defaultProviderId(SUB_NAME, BACKEND),
);
const PROVIDER_NAME = configValue(
  "providerName",
  envKeysForSub("PROVIDER_NAME", ["SUB_BRIDGE_PROVIDER_NAME", "CODEXSUB_PROVIDER_NAME"]),
  defaultProviderName(SUB_NAME, BACKEND),
);
const LEGACY_STATE_DIR = join(homedir(), ".local", "state", "gpt-sub-bridge");
const DEFAULT_STATE_DIR = join(homedir(), ".local", "state", "sub-bridge-cli");
const USE_LEGACY_STATE = existsSync(join(LEGACY_STATE_DIR, "gpt-sub-bridge.pid"));
const STATE_DIR =
  configValue(
    "stateDir",
    envKeysForSub("STATE_DIR", ["SUB_BRIDGE_STATE_DIR", "CODEXSUB_STATE_DIR"]),
    SUB_NAME ? join(DEFAULT_STATE_DIR, slug(SUB_NAME)) : USE_LEGACY_STATE ? LEGACY_STATE_DIR : DEFAULT_STATE_DIR,
  );
const PID_FILE_NAME = USE_LEGACY_STATE && STATE_DIR === LEGACY_STATE_DIR ? "gpt-sub-bridge.pid" : "sub-bridge.pid";
const LOG_FILE_NAME = USE_LEGACY_STATE && STATE_DIR === LEGACY_STATE_DIR ? "gpt-sub-bridge.log" : "sub-bridge.log";
const PID_PATH = configValue(
  "pidPath",
  envKeysForSub("PID_PATH", ["SUB_BRIDGE_PID_PATH", "CODEXSUB_PID_PATH"]),
  join(STATE_DIR, PID_FILE_NAME),
);
const LOG_PATH = configValue(
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
const PI_RUNTIME_DIR =
  configValue(
    "piDir",
    ["SUB_BRIDGE_PI_DIR", "GPT_SUB_BRIDGE_PI_DIR"],
    existsSync(LEGACY_PI_RUNTIME_DIR) ? LEGACY_PI_RUNTIME_DIR : join(homedir(), ".local", "share", "sub-bridge-cli"),
  );
const PI_TRANSPORT = configValue("piTransport", ["SUB_BRIDGE_PI_TRANSPORT", "GPT_SUB_BRIDGE_PI_TRANSPORT"], "auto");
const PI_TIMEOUT_MS = configNumber("timeoutMs", ["SUB_BRIDGE_TIMEOUT_MS", "GPT_SUB_BRIDGE_TIMEOUT_MS"], 600000);
const STRIP_COPILOT_TOOLS = configBoolean(
  "stripTools",
  ["SUB_BRIDGE_STRIP_TOOLS", "GPT_SUB_BRIDGE_STRIP_TOOLS", "CODEXSUB_STRIP_TOOLS"],
  USE_PI_WRAPPER ? "0" : "1",
);
const BASE_URL = `http://${HOST}:${PORT}/v1`;
const HEALTH_URL = `http://${HOST}:${PORT}/healthz`;
const CURSOR_ACP_COMMAND = configValue(
  "cursorAcpCommand",
  envKeysForSub("CURSOR_ACP_COMMAND", ["SUB_BRIDGE_CURSOR_ACP_COMMAND"]),
  defaultCursorAcpCommand(),
);
const CURSOR_API_ENDPOINT = configValue(
  "cursorApiEndpoint",
  envKeysForSub("CURSOR_API_ENDPOINT", ["SUB_BRIDGE_CURSOR_API_ENDPOINT"]),
  "",
);
const CURSOR_WORKSPACE = configValue(
  "cursorWorkspace",
  envKeysForSub("CURSOR_WORKSPACE", ["SUB_BRIDGE_CURSOR_WORKSPACE"]),
  process.cwd(),
);
const CURSOR_MODEL = configValue("cursorModel", envKeysForSub("CURSOR_MODEL", ["SUB_BRIDGE_CURSOR_MODEL"]), "request");
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
const CURSOR_LOCAL_AUTH_KEY_PATH = join(CURSOR_LOCAL_AUTH_DIR, "key");
const CURSOR_LOCAL_AUTH_TOKEN_PATH = join(CURSOR_LOCAL_AUTH_DIR, "token.enc");
let piRuntimePromise = null;

function logLine(message, fields = {}) {
  const suffix = Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
  console.log(`${new Date().toISOString()} ${message}${suffix}`);
}

const BUILTIN_MODELS = [
  {
    id: "gpt-5.5",
    displayName: "SubBridge GPT-5.5",
    contextWindow: 272000,
    maxTokens: 128000,
  },
  {
    id: "gpt-5.4",
    displayName: "SubBridge GPT-5.4",
    contextWindow: 272000,
    maxTokens: 128000,
  },
  {
    id: "gpt-5.4-mini",
    displayName: "SubBridge GPT-5.4 mini",
    contextWindow: 272000,
    maxTokens: 128000,
  },
  {
    id: "gpt-5.3-codex-spark",
    displayName: "SubBridge GPT-5.3 Codex Spark",
    contextWindow: 128000,
    maxTokens: 128000,
  },
];

function normalizeModelEntry(model) {
  if (!model || typeof model !== "object") return null;
  const rawId = model.id || model.slug || model.value || model.modelId || model.name;
  const id = typeof rawId === "string" && rawId.trim() ? rawId.trim() : "";
  if (!id) return null;
  const entry = {
    id,
    displayName:
      typeof model.displayName === "string" && model.displayName.trim()
        ? model.displayName.trim()
        : typeof model.name === "string" && model.name.trim()
          ? model.name.trim()
        : `SubBridge ${id}`,
    contextWindow: Number.isFinite(Number(model.contextWindow)) ? Number(model.contextWindow) : 128000,
    maxTokens: Number.isFinite(Number(model.maxTokens)) ? Number(model.maxTokens) : 128000,
  };
  for (const key of [
    "reasoningEffort",
    "defaultReasoningEffort",
    "cursorContextWindow",
    "cursorContext",
    "contextOption",
    "defaultContextWindow",
    "cursorModel",
    "upstreamProviderId",
    "upstreamProviderName",
  ]) {
    if (typeof model[key] === "string" && model[key].trim()) entry[key] = model[key].trim();
  }
  for (const key of ["fastMode", "thinking", "supportsFastMode"]) {
    if (typeof model[key] === "boolean") entry[key] = model[key];
  }
  const supportsThinking = model.supportsThinking ?? model.supportsThinkingToggle;
  if (typeof supportsThinking === "boolean") entry.supportsThinking = supportsThinking;
  if (Array.isArray(model.supportedReasoningEfforts)) {
    entry.supportedReasoningEfforts = model.supportedReasoningEfforts
      .map((item) => {
        if (typeof item === "string") return { value: item, label: item };
        if (!item || typeof item !== "object" || !item.value) return null;
        return {
          value: String(item.value),
          label: String(item.label || item.value),
          ...(item.isDefault === true ? { isDefault: true } : {}),
        };
      })
      .filter(Boolean);
  }
  if (Array.isArray(model.contextWindowOptions)) {
    entry.contextWindowOptions = model.contextWindowOptions
      .map((item) => {
        if (typeof item === "string") return { value: item, label: item.toUpperCase() };
        if (!item || typeof item !== "object" || !item.value) return null;
        return {
          value: String(item.value),
          label: String(item.label || item.value),
          ...(item.isDefault === true ? { isDefault: true } : {}),
        };
      })
      .filter(Boolean);
  }
  return entry;
}

function normalizeModelList(models) {
  if (!Array.isArray(models)) return [];
  const seen = new Set();
  const normalized = [];
  for (const model of models) {
    const entry = normalizeModelEntry(model);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    normalized.push(entry);
  }
  return normalized;
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

function modelConfigFor(modelId) {
  const normalized = normalizeModelId(modelId);
  const base = stripCursorParameterizedSuffix(normalized);
  return (
    MODELS.find((model) => model.id === normalized) ||
    MODELS.find((model) => stripCursorParameterizedSuffix(model.id) === base) ||
    null
  );
}

function reasoningEffortForModel(modelId) {
  return modelConfigFor(modelId)?.reasoningEffort || REASONING_EFFORT;
}

function cursorOptionsForModel(modelId, body) {
  const modelConfig = modelConfigFor(modelId);
  const bodyReasoning = body?.reasoning?.effort ? { reasoningEffort: body.reasoning.effort } : null;
  return mergeCursorModelOptions(cursorOptionsFromModelEntry(modelConfig), bodyReasoning);
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
  SUB_BRIDGE_REASONING_EFFORT=xhigh
  SUB_BRIDGE_CURSOR_ACP_COMMAND=${CURSOR_ACP_COMMAND}
  SUB_BRIDGE_CURSOR_WORKSPACE=${CURSOR_WORKSPACE}
  SUB_BRIDGE_CURSOR_MODEL=request
  SUB_BRIDGE_CURSOR_AUTH_TOKEN=cursor-token
`);
  process.exit(exitCode);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function ensurePrivateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {}
}

function readOrCreateCursorAuthKey() {
  ensurePrivateDir(CURSOR_LOCAL_AUTH_DIR);
  if (existsSync(CURSOR_LOCAL_AUTH_KEY_PATH)) {
    const key = Buffer.from(readFileSync(CURSOR_LOCAL_AUTH_KEY_PATH, "utf8").trim(), "base64");
    if (key.length === 32) return key;
  }
  const key = randomBytes(32);
  writeFileSync(CURSOR_LOCAL_AUTH_KEY_PATH, `${key.toString("base64")}\n`, { mode: 0o600 });
  try {
    chmodSync(CURSOR_LOCAL_AUTH_KEY_PATH, 0o600);
  } catch {}
  return key;
}

function saveCursorAuthToken(token) {
  const cleanToken = String(token || "").trim();
  if (!cleanToken) throw new Error("Cursor token is empty");
  const key = readOrCreateCursorAuthKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(cleanToken, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  writeJson(CURSOR_LOCAL_AUTH_TOKEN_PATH, {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
  try {
    chmodSync(CURSOR_LOCAL_AUTH_TOKEN_PATH, 0o600);
  } catch {}
}

function loadCursorAuthToken() {
  const envToken = envValue(...envKeysForSub("CURSOR_AUTH_TOKEN", ["SUB_BRIDGE_CURSOR_AUTH_TOKEN", "CURSOR_AUTH_TOKEN"]));
  if (envToken && String(envToken).trim()) return String(envToken).trim();
  if (!existsSync(CURSOR_LOCAL_AUTH_TOKEN_PATH)) return "";
  const payload = readJson(CURSOR_LOCAL_AUTH_TOKEN_PATH);
  const key = readOrCreateCursorAuthKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function cursorAuthTokenPresent() {
  const envToken = envValue(...envKeysForSub("CURSOR_AUTH_TOKEN", ["SUB_BRIDGE_CURSOR_AUTH_TOKEN", "CURSOR_AUTH_TOKEN"]));
  return Boolean(envToken && String(envToken).trim()) || existsSync(CURSOR_LOCAL_AUTH_TOKEN_PATH);
}

function removeCursorAuthToken() {
  try {
    unlinkSync(CURSOR_LOCAL_AUTH_TOKEN_PATH);
  } catch {}
}

function cursorLocalEnvDirs() {
  return {
    configDir: join(CURSOR_LOCAL_AUTH_DIR, "config"),
    dataDir: join(CURSOR_LOCAL_AUTH_DIR, "data"),
    xdgConfigHome: join(CURSOR_LOCAL_AUTH_DIR, "xdg-config"),
  };
}

function makeBridgeCursorEnv({ includeToken = true, forceCi = CURSOR_FORCE_CI } = {}) {
  const dirs = cursorLocalEnvDirs();
  for (const path of Object.values(dirs)) ensurePrivateDir(path);
  const env = makeCursorEnv({ forceCi });
  env.AGENT_CLI_CREDENTIAL_STORE = "memory";
  env.CURSOR_CONFIG_DIR = dirs.configDir;
  env.CURSOR_DATA_DIR = dirs.dataDir;
  env.XDG_CONFIG_HOME = dirs.xdgConfigHome;
  if (includeToken) {
    const token = loadCursorAuthToken();
    if (token) env.CURSOR_AUTH_TOKEN = token;
  }
  return env;
}

function makeCursorRuntimeEnv({ forceCi = CURSOR_FORCE_CI } = {}) {
  return cursorAuthTokenPresent()
    ? makeBridgeCursorEnv({ forceCi })
    : makeCursorEnv({ forceCi });
}

function decodeBase64Url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function decodeJwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(decodeBase64Url(parts[1]));
  } catch {
    return null;
  }
}

function extractAccountId(accessToken, auth) {
  if (auth?.tokens?.account_id) return auth.tokens.account_id;
  const payload = decodeJwtPayload(accessToken);
  const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
  if (typeof accountId === "string" && accountId.length > 0) return accountId;
  throw new Error("Could not extract chatgpt account id from Codex token");
}

function tokenExpiresSoon(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  const exp = payload?.exp;
  if (typeof exp !== "number") return false;
  return exp * 1000 < Date.now() + 60_000;
}

async function refreshAccessToken(auth) {
  const refreshToken = auth?.tokens?.refresh_token;
  if (!refreshToken) {
    throw new Error(`Missing refresh token in ${AUTH_PATH}`);
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Codex token refresh failed (${response.status}): ${text || response.statusText}`);
  }

  const json = await response.json();
  if (!json?.access_token) {
    throw new Error(`Codex token refresh returned no access_token: ${JSON.stringify(json)}`);
  }

  auth.tokens.access_token = json.access_token;
  if (json.refresh_token) auth.tokens.refresh_token = json.refresh_token;
  auth.tokens.account_id = extractAccountId(json.access_token, auth);
  auth.last_refresh = new Date().toISOString();
  writeJson(AUTH_PATH, auth);
  return auth;
}

async function loadCodexAuth({ forceRefresh = false } = {}) {
  let auth = readJson(AUTH_PATH);
  const accessToken = auth?.tokens?.access_token;
  if (!accessToken) {
    throw new Error(`Missing access token in ${AUTH_PATH}. Run Codex login first.`);
  }
  if (forceRefresh || tokenExpiresSoon(accessToken)) {
    auth = await refreshAccessToken(auth);
  }
  const token = auth.tokens.access_token;
  return { token, accountId: extractAccountId(token, auth) };
}

function requireBridgeAuth(req) {
  if (!BRIDGE_KEY) return true;
  const auth = req.headers.authorization || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const xApiKey = String(req.headers["x-api-key"] || req.headers["api-key"] || "");
  return bearer === BRIDGE_KEY || xApiKey === BRIDGE_KEY;
}

function readRequestBody(req, maxBytes = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`Request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function normalizeModelId(model) {
  let value = typeof model === "string" && model.trim() ? model.trim() : DEFAULT_MODEL;
  if (value.includes("#")) value = value.slice(value.lastIndexOf("#") + 1);
  if (value.includes("/")) value = value.slice(value.lastIndexOf("/") + 1);
  if (value === "codexsub") value = DEFAULT_MODEL;
  if (value.startsWith("codexsub:")) value = value.slice("codexsub:".length);
  return value || DEFAULT_MODEL;
}

async function loadPiRuntime() {
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
      const mod = await import(pathToFileURL(providerPath).href);
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

function parseJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function textFromResponsesContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
    } else if (item?.type === "input_text" || item?.type === "output_text" || item?.type === "text") {
      if (typeof item.text === "string") parts.push(item.text);
    } else if (item?.type === "refusal" && typeof item.refusal === "string") {
      parts.push(item.refusal);
    }
  }
  return parts.join("");
}

function imageFromResponsesPart(part) {
  if (!part || part.type !== "input_image") return null;
  const imageUrl = part.image_url?.url || part.image_url;
  if (typeof imageUrl !== "string") return null;
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(imageUrl);
  if (!match) return null;
  return { type: "image", mimeType: match[1], data: match[2] };
}

function userContentFromResponsesContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const blocks = [];
  for (const item of content) {
    if (typeof item === "string") {
      blocks.push({ type: "text", text: item });
      continue;
    }
    const image = imageFromResponsesPart(item);
    if (image) {
      blocks.push(image);
    } else if (item?.type === "input_text" || item?.type === "text") {
      if (typeof item.text === "string") blocks.push({ type: "text", text: item.text });
    }
  }
  if (blocks.length === 0) return "";
  if (blocks.every((block) => block.type === "text")) return blocks.map((block) => block.text).join("");
  return blocks;
}

function normalizeToolCallIds(item) {
  let rawItemId = String(item.id || "");
  let callId = String(item.call_id || "");
  if (rawItemId.includes("|")) {
    const parts = rawItemId.split("|");
    if (!callId) callId = parts[0];
    rawItemId = parts[1] || "";
  }
  if (!callId) callId = rawItemId || `call_${randomUUID().replace(/-/g, "")}`;
  let itemId = rawItemId || `fc_${randomUUID().replace(/-/g, "")}`;
  if (!itemId.startsWith("fc_")) itemId = `fc_${itemId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  return { callId, itemId, combinedId: `${callId}|${itemId}` };
}

function convertResponsesToolsToPi(tools) {
  if (!Array.isArray(tools)) return [];
  const converted = [];
  for (const tool of tools) {
    const source = tool?.function && typeof tool.function === "object" ? tool.function : tool;
    const name = source?.name;
    if (tool?.type && tool.type !== "function") continue;
    if (typeof name !== "string" || !name) continue;
    converted.push({
      name,
      description: typeof source.description === "string" ? source.description : "",
      parameters:
        source.parameters && typeof source.parameters === "object"
          ? source.parameters
          : { type: "object", properties: {}, additionalProperties: false },
    });
  }
  return converted;
}

function responsesBodyToPiContext(body) {
  const model = normalizeModelId(body.model);
  const messages = [];
  const systemParts = [];
  const toolNamesByCallId = new Map();

  if (typeof body.instructions === "string" && body.instructions) {
    systemParts.push(body.instructions);
  }

  const input = typeof body.input === "string" ? [{ role: "user", content: body.input }] : body.input;
  for (const item of Array.isArray(input) ? input : []) {
    if (!item || typeof item !== "object") continue;

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
      const output = textFromResponsesContent(item.output || item.content);
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

function sseWrite(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify({ type: event, ...data })}\n\n`);
}

function sseDone(res) {
  res.write("data: [DONE]\n\n");
}

function responseObject({ id, model, status = "in_progress", output = [], usage = null, error = null }) {
  const response = {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
  };
  if (usage) response.usage = usage;
  if (error) response.error = error;
  return response;
}

function normalizeResponseUsage(usage) {
  if (!usage) return null;
  return {
    input_tokens: usage.input + usage.cacheRead + usage.cacheWrite,
    output_tokens: usage.output,
    total_tokens: usage.totalTokens || usage.input + usage.cacheRead + usage.cacheWrite + usage.output,
    input_tokens_details: { cached_tokens: usage.cacheRead || 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
}

async function collectPiResponse({ provider, model, context, token, sessionId, body, signal }) {
  const output = [];
  const openItems = new Map();
  let finalMessage = null;
  let stopReason = "stop";
  const effectiveReasoningEffort = body.reasoning?.effort || reasoningEffortForModel(model.id);
  const piStream = provider.stream(model, context, {
    apiKey: token,
    reasoningEffort: effectiveReasoningEffort,
    reasoningSummary: "auto",
    textVerbosity: body.text?.verbosity || "low",
    sessionId,
    transport: PI_TRANSPORT,
    timeoutMs: PI_TIMEOUT_MS,
    websocketConnectTimeoutMs: 15000,
    maxRetries: 1,
    signal,
    onPayload: (payload) => {
      logLine("responses.pi_payload", {
        model: model.id,
        inputItems: Array.isArray(payload?.input) ? payload.input.length : null,
        toolsOut: Array.isArray(payload?.tools) ? payload.tools.length : 0,
        reasoningEffort: payload?.reasoning?.effort || null,
        transport: PI_TRANSPORT,
      });
    },
    onResponse: (response) => {
      logLine("responses.upstream", {
        status: response.status,
        contentType: response.headers?.["content-type"] || "",
        runtime: "pi",
      });
    },
  });

  for await (const event of piStream) {
    if (event.type === "text_start") {
      const item = {
        id: `msg_${randomUUID().replace(/-/g, "")}`,
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [{ type: "output_text", text: "", annotations: [] }],
      };
      output.push(item);
      openItems.set(event.contentIndex, { item, text: "", kind: "text" });
      continue;
    }

    if (event.type === "text_delta") {
      const entry = openItems.get(event.contentIndex);
      if (!entry || entry.kind !== "text") continue;
      entry.text += event.delta;
      entry.item.content[0].text = entry.text;
      continue;
    }

    if (event.type === "text_end") {
      const entry = openItems.get(event.contentIndex);
      if (!entry || entry.kind !== "text") continue;
      entry.text = event.content;
      entry.item.status = "completed";
      entry.item.content[0].text = event.content;
      openItems.delete(event.contentIndex);
      continue;
    }

    if (event.type === "toolcall_start") {
      const block = event.partial?.content?.[event.contentIndex] || {};
      const ids = normalizeToolCallIds({
        id: String(block.id || ""),
        call_id: String(block.id || "").split("|")[0] || undefined,
      });
      const item = {
        id: ids.itemId,
        type: "function_call",
        call_id: ids.callId,
        name: block.name || "tool",
        arguments: "",
        status: "in_progress",
      };
      output.push(item);
      openItems.set(event.contentIndex, { item, args: "", kind: "tool" });
      continue;
    }

    if (event.type === "toolcall_delta") {
      const entry = openItems.get(event.contentIndex);
      if (!entry || entry.kind !== "tool") continue;
      entry.args += event.delta;
      entry.item.arguments = entry.args;
      continue;
    }

    if (event.type === "toolcall_end") {
      const entry = openItems.get(event.contentIndex);
      if (!entry || entry.kind !== "tool") continue;
      const ids = normalizeToolCallIds({
        id: event.toolCall?.id?.split("|")[1] || entry.item.id,
        call_id: event.toolCall?.id?.split("|")[0] || entry.item.call_id,
      });
      entry.item.id = ids.itemId;
      entry.item.call_id = ids.callId;
      entry.item.name = event.toolCall?.name || entry.item.name;
      entry.item.arguments = JSON.stringify(event.toolCall?.arguments || parseJsonObject(entry.args));
      entry.item.status = "completed";
      openItems.delete(event.contentIndex);
      continue;
    }

    if (event.type === "done") {
      finalMessage = event.message;
      stopReason = event.reason;
      break;
    }

    if (event.type === "error") {
      throw new Error(event.error?.errorMessage || "Pi stream failed");
    }
  }

  return {
    output,
    usage: normalizeResponseUsage(finalMessage?.usage),
    status: stopReason === "length" ? "incomplete" : "completed",
    stopReason,
  };
}

function normalizeRequestBody(bodyText, { stripTools = STRIP_COPILOT_TOOLS } = {}) {
  let body;
  if (!bodyText.trim()) {
    body = {
      model: DEFAULT_MODEL,
      store: false,
      stream: true,
      instructions: "You are a helpful coding assistant.",
      input: [],
    };
  } else {
    body = JSON.parse(bodyText);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Responses request body must be a JSON object");
  }

  body.model = normalizeModelId(body.model);
  if (body.store === undefined) body.store = false;
  if (body.stream === undefined) body.stream = true;
  const effectiveReasoningEffort = reasoningEffortForModel(body.model);
  if (effectiveReasoningEffort) {
    const currentReasoning =
      body.reasoning && typeof body.reasoning === "object" && !Array.isArray(body.reasoning)
        ? body.reasoning
        : {};
    body.reasoning = { ...currentReasoning, effort: effectiveReasoningEffort };
  }

  const strippedParams = [];
  if (Object.prototype.hasOwnProperty.call(body, "max_output_tokens")) {
    delete body.max_output_tokens;
    strippedParams.push("max_output_tokens");
  }

  const toolsIn = Array.isArray(body.tools) ? body.tools.length : 0;
  let strippedTools = false;
  if (stripTools && toolsIn > 0) {
    delete body.tools;
    delete body.tool_choice;
    delete body.parallel_tool_calls;
    strippedTools = true;
  }
  const toolsOut = Array.isArray(body.tools) ? body.tools.length : 0;

  return {
    body: JSON.stringify(body),
    info: {
      model: body.model,
      stream: body.stream,
      inputType: Array.isArray(body.input) ? "array" : typeof body.input,
      toolsIn,
      toolsOut,
      strippedTools,
      strippedParams,
      reasoningEffort: body.reasoning?.effort || null,
    },
  };
}

function logPrefix(text, maxLength = 1200) {
  const value = String(text || "");
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...[truncated ${value.length - maxLength} chars]`;
}

function codexHeaders(token, accountId, req) {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("chatgpt-account-id", accountId);
  headers.set("originator", ORIGINATOR);
  headers.set("User-Agent", `codexsub (${platform()} ${release()}; ${arch()})`);
  headers.set("OpenAI-Beta", "responses=experimental");
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");

  const sessionId =
    req.headers["session-id"] ||
    req.headers["x-client-request-id"] ||
    req.headers["x-request-id"] ||
    randomUUID();
  headers.set("session-id", String(sessionId));
  headers.set("x-client-request-id", String(sessionId));
  return headers;
}

async function forwardResponsesPi(req, res, bodyText) {
  const startedAt = Date.now();
  const normalized = normalizeRequestBody(bodyText);
  const body = JSON.parse(normalized.body);
  const { provider, models } = await loadPiRuntime();
  const model = models.get(body.model) || models.get(DEFAULT_MODEL);
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
  const output = [];
  const openItems = new Map();
  let bytes = 0;
  let headerLogged = false;
  const streamStartedAt = Date.now();
  const recordWrite = (event, data) => {
    const before = res.writableLength;
    sseWrite(res, event, data);
    bytes += Math.max(0, res.writableLength - before);
  };

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

  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-sub-bridge-runtime", "pi");
  res.setHeader("x-sub-bridge-transport", PI_TRANSPORT);
  if (normalized.info.strippedParams.length > 0) {
    res.setHeader("x-sub-bridge-stripped-params", normalized.info.strippedParams.join(","));
  }

  recordWrite("response.created", {
    response: responseObject({ id: responseId, model: model.id, output }),
  });

  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  let piStream;
  try {
    piStream = provider.stream(model, context, {
      apiKey: token,
      reasoningEffort: body.reasoning?.effort || reasoningEffortForModel(model.id),
      reasoningSummary: "auto",
      textVerbosity: body.text?.verbosity || "low",
      sessionId,
      transport: PI_TRANSPORT,
      timeoutMs: PI_TIMEOUT_MS,
      websocketConnectTimeoutMs: 15000,
      maxRetries: 1,
      signal: controller.signal,
      onPayload: (payload) => {
        logLine("responses.pi_payload", {
          model: model.id,
          inputItems: Array.isArray(payload?.input) ? payload.input.length : null,
          toolsOut: Array.isArray(payload?.tools) ? payload.tools.length : 0,
          reasoningEffort: payload?.reasoning?.effort || null,
          transport: PI_TRANSPORT,
        });
      },
      onResponse: (response) => {
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
  } catch (error) {
    throw error;
  }

  const finishOpenPiItems = () => {
    for (const entry of openItems.values()) {
      if (entry.kind === "text") {
        entry.item.status = "completed";
        entry.item.content[0].text = entry.text;
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
          part: entry.item.content[0],
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

  const completeCancelledPiStream = (error) => {
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

  const failPiStream = (error) => {
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

  let finalMessage = null;
  try {
    for await (const event of piStream) {
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
      const item = {
        id: itemId,
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [],
      };
      output.push(item);
      openItems.set(event.contentIndex, { outputIndex, item, text: "", kind: "text" });
      recordWrite("response.output_item.added", { output_index: outputIndex, item });
      const part = { type: "output_text", text: "", annotations: [] };
      item.content.push(part);
      recordWrite("response.content_part.added", {
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        part,
      });
      continue;
    }

    if (event.type === "text_delta") {
      const entry = openItems.get(event.contentIndex);
      if (!entry || entry.kind !== "text") continue;
      entry.text += event.delta;
      entry.item.content[0].text = entry.text;
      recordWrite("response.output_text.delta", {
        item_id: entry.item.id,
        output_index: entry.outputIndex,
        content_index: 0,
        delta: event.delta,
      });
      continue;
    }

    if (event.type === "text_end") {
      const entry = openItems.get(event.contentIndex);
      if (!entry || entry.kind !== "text") continue;
      entry.text = event.content;
      entry.item.status = "completed";
      entry.item.content[0].text = event.content;
      recordWrite("response.output_text.done", {
        item_id: entry.item.id,
        output_index: entry.outputIndex,
        content_index: 0,
        text: event.content,
      });
      recordWrite("response.content_part.done", {
        item_id: entry.item.id,
        output_index: entry.outputIndex,
        content_index: 0,
        part: entry.item.content[0],
      });
      recordWrite("response.output_item.done", {
        output_index: entry.outputIndex,
        item: entry.item,
      });
      openItems.delete(event.contentIndex);
      continue;
    }

    if (event.type === "toolcall_start") {
      const block = event.partial?.content?.[event.contentIndex] || {};
      const ids = normalizeToolCallIds({
        id: String(block.id || ""),
        call_id: String(block.id || "").split("|")[0] || undefined,
      });
      const outputIndex = output.length;
      const item = {
        id: ids.itemId,
        type: "function_call",
        call_id: ids.callId,
        name: block.name || "tool",
        arguments: "",
        status: "in_progress",
      };
      output.push(item);
      openItems.set(event.contentIndex, { outputIndex, item, args: "", kind: "tool" });
      recordWrite("response.output_item.added", { output_index: outputIndex, item });
      continue;
    }

    if (event.type === "toolcall_delta") {
      const entry = openItems.get(event.contentIndex);
      if (!entry || entry.kind !== "tool") continue;
      entry.args += event.delta;
      entry.item.arguments = entry.args;
      recordWrite("response.function_call_arguments.delta", {
        item_id: entry.item.id,
        output_index: entry.outputIndex,
        delta: event.delta,
      });
      continue;
    }

    if (event.type === "toolcall_end") {
      const entry = openItems.get(event.contentIndex);
      if (!entry || entry.kind !== "tool") continue;
      const ids = normalizeToolCallIds({
        id: event.toolCall?.id?.split("|")[1] || entry.item.id,
        call_id: event.toolCall?.id?.split("|")[0] || entry.item.call_id,
      });
      const args = JSON.stringify(event.toolCall?.arguments || parseJsonObject(entry.args));
      entry.item.id = ids.itemId;
      entry.item.call_id = ids.callId;
      entry.item.name = event.toolCall?.name || entry.item.name;
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
      openItems.delete(event.contentIndex);
      continue;
    }

    if (event.type === "done") {
      finalMessage = event.message;
      const usage = normalizeResponseUsage(event.message?.usage);
      recordWrite("response.completed", {
        response: responseObject({
          id: responseId,
          model: model.id,
          status: event.reason === "length" ? "incomplete" : "completed",
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
        bytes,
        runtime: "pi",
        stopReason: event.reason,
      });
      return;
    }

    if (event.type === "error") {
      const message = event.error?.errorMessage || "Pi stream failed";
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
          usage: normalizeResponseUsage(event.error?.usage),
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
  } catch (error) {
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

async function forwardResponsesRaw(req, res, bodyText, retry = true) {
  const startedAt = Date.now();
  const { token, accountId } = await loadCodexAuth();
  const url = `${DEFAULT_CODEX_BASE_URL}${CODEX_RESPONSES_PATH}`;
  const normalized = normalizeRequestBody(bodyText);
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
    return forwardResponses(req, res, bodyText, false);
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
  upstreamStream.on("error", (error) => {
    logLine(isAbortLikeError(error) || res.destroyed ? "responses.cancelled" : "responses.stream_error", {
      status: upstream.status,
      model: normalized.info.model,
      totalMs: Date.now() - startedAt,
      message: errorMessage(error),
    });
  });
  upstreamStream.pipe(res);
}

function resolveCursorAcpModel(requestModel) {
  const modelConfig = modelConfigFor(requestModel);
  const configured = String(modelConfig?.cursorModel || CURSOR_MODEL || "request").trim();
  if (!configured || configured === "request") return requestModel;
  if (configured === "auto" || configured === "default") return "default";
  return configured;
}

function safeToolIdentifier(value, fallback = "tool") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

const CURSOR_COPILOT_TOOL_KINDS = new Set(["execute", "search", "read", "edit", "delete", "move", "fetch", "tool"]);

function cursorToolKind(toolCall) {
  const kind = safeToolIdentifier(toolCall?.kind || "tool", "tool");
  return CURSOR_COPILOT_TOOL_KINDS.has(kind) ? kind : "tool";
}

function cursorToolName(toolCall) {
  return `subbridge_cursor_${cursorToolKind(toolCall)}`;
}

function cursorToolArguments(toolCall) {
  return JSON.stringify({
    title: toolCall.title || cursorToolName(toolCall),
    status: toolCall.status || "in_progress",
    kind: toolCall.kind || "tool",
    ...(toolCall.detail ? { detail: toolCall.detail } : {}),
    ...(toolCall.command ? { command: toolCall.command } : {}),
    ...(toolCall.data?.rawInput !== undefined ? { input: toolCall.data.rawInput } : {}),
    ...(toolCall.data?.rawOutput !== undefined ? { output: toolCall.data.rawOutput } : {}),
    ...(toolCall.data?.locations !== undefined ? { locations: toolCall.data.locations } : {}),
  });
}

function truncateOneLine(value, maxLength = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function cursorToolSummaryLine(toolCall) {
  const status = toolCall?.status || "in_progress";
  const kind = toolCall?.kind || "tool";
  const title = toolCall?.title || cursorToolName(toolCall);
  const detail = toolCall?.command || toolCall?.detail || "";
  const suffix = detail ? ` - ${truncateOneLine(detail)}` : "";
  return `[cursor:${kind}:${status}] ${truncateOneLine(title, 120)}${suffix}\n`;
}

function mergeCursorToolCallState(previous, next) {
  if (!previous) return next;
  return {
    ...previous,
    ...next,
    kind: next.kind || previous.kind,
    status: next.status || previous.status,
    title: next.title || previous.title,
    command: next.command || previous.command,
    detail: next.detail || previous.detail,
    data: {
      ...(previous.data || {}),
      ...(next.data || {}),
    },
  };
}

function cursorToolStatusIsTerminal(status) {
  return status === "completed" || status === "failed";
}

function appendCursorJsonOutputFromEvents(output, events, fallbackText) {
  let reasoningText = "";
  let assistantText = "";
  const tools = new Map();

  for (const event of Array.isArray(events) ? events : []) {
    if (event.type === "content_delta" && event.streamKind === "reasoning_text") {
      reasoningText += event.text;
      continue;
    }
    if (event.type === "content_delta" && event.streamKind === "assistant_text") {
      assistantText += event.text;
      continue;
    }
    if (event.type === "tool_call") {
      const existing = tools.get(event.toolCall.id);
      const toolCall = mergeCursorToolCallState(existing?.toolCall, event.toolCall);
      logLine("cursor.tool_call", JSON.parse(cursorToolArguments(toolCall)));
      tools.set(toolCall.id, { toolCall });
    }
  }

  for (const entry of tools.values()) {
    reasoningText += cursorToolSummaryLine(entry.toolCall);
  }

  if (reasoningText) {
    output.push({
      id: `rs_${randomUUID().replace(/-/g, "")}`,
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: reasoningText }],
    });
  }
  const finalText = assistantText || fallbackText;
  if (finalText) {
    output.push({
      id: `msg_${randomUUID().replace(/-/g, "")}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: finalText, annotations: [] }],
    });
  }
}

async function forwardResponsesCursorAcp(req, res, bodyText) {
  const startedAt = Date.now();
  const normalized = normalizeRequestBody(bodyText, { stripTools: true });
  const body = JSON.parse(normalized.body);
  const responseId = `resp_${randomUUID().replace(/-/g, "")}`;
  const output = [];
  const actualCursorModel = resolveCursorAcpModel(body.model);

  logLine("responses.forward", {
    path: req.url,
    model: body.model,
    cursorModel: actualCursorModel,
    stream: body.stream,
    inputType: normalized.info.inputType,
    toolsIn: normalized.info.toolsIn,
    toolsOut: 0,
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
    reasoningEffort: reasoningEffortForModel(body.model),
    modelOptions: cursorOptionsForModel(body.model, body),
    body,
    onStderr: (chunk) => {
      const text = String(chunk || "").trim();
      if (text) logLine("cursor.stderr", { text: logPrefix(text, 500) });
    },
    onProtocolError: (error) => {
      logLine("cursor.protocol_error", { message: error instanceof Error ? error.message : String(error) });
    },
  };

  if (body.stream === false) {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    const result = await runCursorAcpTurn({ ...runOptionsBase, signal: controller.signal });
    appendCursorJsonOutputFromEvents(output, result.events, result.text);
    json(res, 200, responseObject({
      id: responseId,
      model: body.model,
      status: "completed",
      output,
      usage: result.usage,
    }));
    logLine("responses.complete", {
      status: 200,
      model: body.model,
      cursorModel: actualCursorModel,
      responseFormat: "json",
      totalMs: Date.now() - startedAt,
      runtime: "cursor-acp",
      stopReason: result.stopReason,
    });
    return;
  }

  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-sub-bridge-runtime", "cursor-acp");
  res.setHeader("x-sub-bridge-cursor-model", actualCursorModel);

  let bytes = 0;
  const recordWrite = (event, data) => {
    const before = res.writableLength;
    sseWrite(res, event, data);
    bytes += Math.max(0, res.writableLength - before);
  };

  recordWrite("response.created", {
    response: responseObject({ id: responseId, model: body.model, output }),
  });

  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  let nextOutputIndex = 0;
  let assistantEntry = null;
  let reasoningEntry = null;
  const toolEntries = new Map();

  const addOutputItem = (item) => {
    const outputIndex = nextOutputIndex;
    nextOutputIndex += 1;
    output.push(item);
    recordWrite("response.output_item.added", { output_index: outputIndex, item });
    return outputIndex;
  };

  const ensureAssistantEntry = () => {
    if (assistantEntry) return assistantEntry;
    const item = {
      id: `msg_${randomUUID().replace(/-/g, "")}`,
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: [],
    };
    const outputIndex = addOutputItem(item);
    const part = { type: "output_text", text: "", annotations: [] };
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
    entry.item.status = "completed";
    entry.part.text = entry.text;
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

  const ensureReasoningEntry = () => {
    if (reasoningEntry) return reasoningEntry;
    const item = {
      id: `rs_${randomUUID().replace(/-/g, "")}`,
      type: "reasoning",
      status: "in_progress",
      summary: [],
    };
    const outputIndex = addOutputItem(item);
    const part = { type: "summary_text", text: "" };
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

  const appendReasoningText = (text) => {
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

  const applyToolCallEvent = (eventToolCall) => {
    finishAssistantEntry();
    const existingEntry = toolEntries.get(eventToolCall.id);
    const toolCall = mergeCursorToolCallState(existingEntry?.toolCall, eventToolCall);
    logLine("cursor.tool_call", JSON.parse(cursorToolArguments(toolCall)));
    let entry = existingEntry || { toolCall, startReported: false, terminalReported: false };
    entry.toolCall = toolCall;
    if (!existingEntry) toolEntries.set(toolCall.id, entry);
    if (!entry.startReported && !cursorToolStatusIsTerminal(toolCall.status)) {
      appendReasoningText(cursorToolSummaryLine(toolCall));
      entry.startReported = true;
    }
    if (cursorToolStatusIsTerminal(toolCall.status) && !entry.terminalReported) {
      appendReasoningText(cursorToolSummaryLine(toolCall));
      entry.terminalReported = true;
    }
  };

  const finishOpenToolEntries = () => {
    for (const entry of toolEntries.values()) {
      if (entry.terminalReported) continue;
      appendReasoningText(cursorToolSummaryLine(entry.toolCall));
      entry.terminalReported = true;
    }
    toolEntries.clear();
  };

  const applyCursorEvent = (event) => {
    if (event.type === "content_delta" && event.streamKind === "assistant_text") {
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
    if (event.type === "content_delta" && event.streamKind === "reasoning_text") {
      appendReasoningText(event.text);
      return;
    }
    if (event.type === "tool_call") {
      applyToolCallEvent(event.toolCall);
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
    recordWrite("response.completed", {
      response: responseObject({
        id: responseId,
        model: body.model,
        status: "completed",
        output,
        usage: result.usage,
      }),
    });
    sseDone(res);
    res.end();
    logLine("responses.complete", {
      status: 200,
      model: body.model,
      cursorModel: actualCursorModel,
      totalMs: Date.now() - startedAt,
      bytes,
      runtime: "cursor-acp",
      stopReason: result.stopReason,
    });
  } catch (error) {
    const message = errorMessage(error);
    if (isAbortLikeError(error) || controller.signal.aborted || res.destroyed) {
      if (!res.writableEnded && !res.destroyed) {
        finishReasoningEntry();
        finishAssistantEntry();
        finishOpenToolEntries();
        recordWrite("response.completed", {
          response: responseObject({
            id: responseId,
            model: body.model,
            status: "completed",
            output,
          }),
        });
        sseDone(res);
        res.end();
      }
      logLine("responses.cancelled", {
        status: 200,
        model: body.model,
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
    recordWrite("response.failed", {
      response: responseObject({
        id: responseId,
        model: body.model,
        status: "failed",
        output,
        error: { message, type: "bridge_error" },
      }),
    });
    sseDone(res);
    res.end();
    logLine("responses.stream_error", {
      status: 200,
      model: body.model,
      cursorModel: actualCursorModel,
      totalMs: Date.now() - startedAt,
      message,
      runtime: "cursor-acp",
    });
  }
}

async function forwardResponses(req, res, bodyText) {
  return PROVIDER_PLUGIN.forwardResponses(providerPluginContext(), req, res, bodyText);
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(`${JSON.stringify(body, null, 2)}\n`);
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

      const isResponsesPath = url.pathname === "/v1/responses" || url.pathname === "/responses";
      if (isResponsesPath && req.method === "POST") {
        if (!requireBridgeAuth(req)) {
          json(res, 401, { error: { message: "Unauthorized", type: "unauthorized" } });
          return;
        }
        const bodyText = await readRequestBody(req);
        await forwardResponses(req, res, bodyText);
        return;
      }

      if (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions") {
        json(res, 400, {
          error: {
            message: "SubBridge is configured for OpenAI Responses wire API. Set the provider wireApi to responses.",
            type: "unsupported_endpoint",
          },
        });
        return;
      }

      json(res, 404, { error: { message: `Unknown route: ${url.pathname}`, type: "not_found" } });
    } catch (error) {
      json(res, 500, { error: { message: error instanceof Error ? error.message : String(error), type: "bridge_error" } });
    }
  });

  process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });

  server.listen(PORT, HOST, () => {
    console.log(`${CLI_NAME} listening on http://${HOST}:${PORT}`);
    console.log(`provider base URL: ${BASE_URL}`);
    console.log(`wireApi: responses`);
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

function isPidRunning(pid) {
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

function runSubscriptionCommand(subscriptionName, commandName) {
  const result = spawnSync(process.execPath, [process.argv[1], "--sub", subscriptionName, commandName], {
    stdio: "inherit",
    env: process.env,
  });
  if ((result.status ?? 1) !== 0) process.exitCode = result.status ?? 1;
}

function runSubscriptionCommandJson(subscriptionName, commandName) {
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

async function fetchJson(url) {
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
    const statuses = {};
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
    wire_api: "responses",
    type: BACKEND,
    default_model: DEFAULT_MODEL,
    ...pluginStatusFields,
    health: health?.body || null,
    pid_path: PID_PATH,
    log_path: LOG_PATH,
  }, null, 2));
}

function runProbe(command, args = [], options = {}) {
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

function commandProbe(command, args = ["--version"], options = {}) {
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

function providerPluginContext() {
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
    fetchCursorModelSnapshot,
    fetchCodexModelSnapshot,
    forwardResponsesCursorAcp,
    forwardResponsesPi,
    forwardResponsesRaw,
  };
}

function codexAuthDoctor() {
  const details = {
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
    const auth = readJson(AUTH_PATH);
    const accessToken = auth?.tokens?.access_token;
    const refreshToken = auth?.tokens?.refresh_token;
    details.accessTokenPresent = typeof accessToken === "string" && accessToken.length > 0;
    details.refreshTokenPresent = typeof refreshToken === "string" && refreshToken.length > 0;
    try {
      details.accountIdPresent = Boolean(details.accessTokenPresent && extractAccountId(accessToken, auth));
    } catch {}
    const payload = decodeJwtPayload(accessToken);
    if (typeof payload?.exp === "number") {
      details.expiresAt = new Date(payload.exp * 1000).toISOString();
      details.expiresInSeconds = Math.floor(payload.exp - Date.now() / 1000);
    }
  } catch (error) {
    details.error = error instanceof Error ? error.message : String(error);
  }
  return details;
}

function cursorAuthDoctor() {
  return {
    dir: CURSOR_LOCAL_AUTH_DIR,
    tokenPath: CURSOR_LOCAL_AUTH_TOKEN_PATH,
    tokenExists: existsSync(CURSOR_LOCAL_AUTH_TOKEN_PATH),
    envTokenPresent: Boolean(envValue(...envKeysForSub("CURSOR_AUTH_TOKEN", ["SUB_BRIDGE_CURSOR_AUTH_TOKEN", "CURSOR_AUTH_TOKEN"]))),
  };
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

function copilotDoctor() {
  const details = {
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
    details.error = providerResult.stderr || providerResult.error;
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
  let health = null;
  try {
    health = await fetchJson(HEALTH_URL);
  } catch (error) {
    health = { ok: false, status: null, body: null, error: error instanceof Error ? error.message : String(error) };
  }

  const providerDoctor = PROVIDER_PLUGIN.doctor(providerPluginContext());
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
      healthError: health?.error || null,
    },
    tools: {
      node: { version: process.version },
      ...providerDoctor.tools,
      sqlite3: commandProbe("sqlite3", ["--version"]),
    },
    auth: providerDoctor.auth,
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
  saveCursorAuthToken(token);
  console.log(`stored cursor auth token: ${CURSOR_LOCAL_AUTH_TOKEN_PATH}`);
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
  console.log(`removed cursor auth token: ${CURSOR_LOCAL_AUTH_TOKEN_PATH}`);
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

function modelsFromJson(value) {
  const source = Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : Array.isArray(value?.models) ? value.models : [];
  return normalizeModelList(
    source.map((model) => {
      if (typeof model === "string") return { id: model, displayName: `SubBridge ${model}` };
      const id = model?.id || model?.modelId || model?.name;
      return {
        ...model,
        id,
        displayName: model?.displayName || model?.name || id,
        contextWindow: model?.contextWindow || model?.max_prompt_tokens || model?.maxPromptTokens,
        maxTokens: model?.maxTokens || model?.max_output_tokens || model?.maxOutputTokens,
      };
    }),
  );
}

function modelsFromText(text) {
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

function parseModelCommandOutput(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return [];
  try {
    return modelsFromJson(JSON.parse(trimmed));
  } catch {
    return modelsFromText(trimmed);
  }
}

function mergeFetchedModels(fetchedModels, configuredModels) {
  const configuredById = new Map(normalizeModelList(configuredModels).map((model) => [model.id, model]));
  const optionKeys = [
    "reasoningEffort",
    "fastMode",
    "thinking",
    "cursorContextWindow",
    "cursorContext",
    "contextOption",
    "cursorModel",
  ];
  return normalizeModelList(fetchedModels).map((model) => {
    const configured =
      configuredById.get(model.id) ||
      configuredById.get(stripCursorParameterizedSuffix(model.id));
    if (!configured) return model;
    const merged = { ...model };
    for (const key of optionKeys) {
      if (configured[key] !== undefined) merged[key] = configured[key];
    }
    return merged;
  });
}

function mergeCursorDiscoveredModels(primaryModels, additionalModels) {
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

function mergeCursorCliModelSnapshot(snapshot) {
  const cliSnapshot = fetchCursorModelCommandSnapshot();
  if (cliSnapshot.source === "builtin") return snapshot;
  return {
    ...snapshot,
    source: `${snapshot.source}+${cliSnapshot.source}`,
    models: mergeCursorDiscoveredModels(snapshot.models, cliSnapshot.models),
  };
}

async function fetchCursorModelSnapshot() {
  if (OFFLINE_DISCOVERY) {
    return { models: BUILTIN_MODELS, source: "builtin", offline: true };
  }

  const fetchViaAcp = async (env, source) => {
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
  } catch (error) {
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
  } catch (error) {
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

function parseConfigInput(key, value) {
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
    } catch (error) {
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

function redactedConfig(value) {
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

function resolveCursorModelGroupId(value) {
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

function resolveCursorModelGroupIds(values) {
  const groupIds = values.map(resolveCursorModelGroupId);
  return Array.from(new Set(groupIds));
}

function writeCursorModelGroupState(groupId, enabled) {
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

function writeCursorModelGroupOnly(groupIds) {
  const current = normalizeModelGroupsConfig(CONFIG.modelGroups);
  writeActiveConfigValue("modelGroups", {
    disabled: [],
    only: Array.from(new Set(groupIds)),
    preset: current.preset,
  });
}

function writeCursorModelGroupPreset(preset) {
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

function writeConfigFile(config) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  const tempPath = `${CONFIG_PATH}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tempPath, CONFIG_PATH);
}

function writeActiveConfigValue(key, value) {
  const configKey = key;
  if (!SUB_NAME) {
    if (configKey === "$schema" || configKey === "version") {
      writeConfigFile({ ...configDocument(), [configKey]: value });
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

function unsetActiveConfigValue(key) {
  const configKey = key;
  if (!SUB_NAME) {
    if (configKey === "$schema" || configKey === "version") {
      const nextConfig = configDocument();
      delete nextConfig[configKey];
      writeConfigFile(nextConfig);
      return;
    }
    throw new Error(`Use --sub <name> for config unset ${configKey}`);
  }
  const subscriptions = subscriptionsFromConfig(CONFIG_FILE);
  const subscriptionConfig =
    subscriptions[SUB_NAME] && typeof subscriptions[SUB_NAME] === "object" && !Array.isArray(subscriptions[SUB_NAME])
      ? { ...subscriptions[SUB_NAME] }
      : {};
  delete subscriptionConfig[configKey];
  subscriptions[SUB_NAME] = normalizeSubscriptionConfig(subscriptionConfig);
  writeConfigFile(configDocument(subscriptions));
}

function writeSubscriptionConfig(subscriptionName, subscriptionConfig) {
  const subscriptions = subscriptionsFromConfig(CONFIG_FILE);
  subscriptions[subscriptionName] = normalizeSubscriptionConfig(subscriptionConfig);
  writeConfigFile(configDocument(subscriptions));
}

async function configCommand(args) {
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
    if (!CONFIG_SCHEMA.has(key)) throw new Error(`Unknown config key: ${key}`);
    if (!SUB_NAME && key !== "$schema" && key !== "version") {
      throw new Error(`Use --sub <name> for config get ${key}`);
    }
    if (key === "$schema" || key === "version") {
      console.log(JSON.stringify(configDocument()[key], null, 2));
      return;
    }
    const value = effectiveConfig()[key] ?? CONFIG[key] ?? null;
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

function extractOutputTextFromSse(text) {
  let doneText = "";
  let deltaText = "";
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
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

  const headers = { "content-type": "application/json" };
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

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

const COPILOT_CURSOR_TOOL_KINDS = ["execute", "search", "read", "edit", "delete", "move", "fetch", "tool"];

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
  if (input.output !== undefined) lines.push("output: " + JSON.stringify(input.output));
  return lines.join("\\n");
}

function defineSubBridgeCursorTool(kind) {
  return {
    name: "subbridge_cursor_" + kind,
    description: "Displays a Cursor ACP tool event that was executed by the SubBridge provider runtime.",
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
    wireApi: "responses",
    azureApiVersion: null,
    authKind: "api_key",
    headers: {},
  });

  const providerSql = `
insert into model_providers
  (id, name, base_url, wire_api, azure_api_version, auth_kind, headers_json, type, settings_json)
values
  (${sqlQuote(PROVIDER_ID)}, ${sqlQuote(PROVIDER_NAME)}, ${sqlQuote(baseUrl)}, 'responses', null, 'api_key', '{}', 'custom', ${sqlQuote(settingsJson)})
on conflict(id) do update set
  name=excluded.name,
  base_url=excluded.base_url,
  wire_api=excluded.wire_api,
  azure_api_version=excluded.azure_api_version,
  auth_kind=excluded.auth_kind,
  headers_json=excluded.headers_json,
  type=excluded.type,
  settings_json=excluded.settings_json,
  updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
`;

  const deleteModelsSql = `delete from provider_models where provider_id=${sqlQuote(PROVIDER_ID)};`;

  const modelSql = MODELS.map((model) => {
    const id = `${PROVIDER_ID}/${model.id}`;
    return `
	insert into provider_models
	  (id, provider_id, model_id, wire_model, display_name, max_prompt_tokens, max_output_tokens, wire_api_override)
values
  (${sqlQuote(id)}, ${sqlQuote(PROVIDER_ID)}, ${sqlQuote(model.id)}, ${sqlQuote(model.id)}, ${sqlQuote(model.displayName)}, ${model.contextWindow}, ${model.maxTokens}, 'responses')
on conflict(id) do update set
  provider_id=excluded.provider_id,
  model_id=excluded.model_id,
  wire_model=excluded.wire_model,
  display_name=excluded.display_name,
  max_prompt_tokens=excluded.max_prompt_tokens,
  max_output_tokens=excluded.max_output_tokens,
  wire_api_override=excluded.wire_api_override,
  updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
`;
  }).join("\n");

  const sql = `begin;\n${providerSql}\n${deleteModelsSql}\n${modelSql}\ncommit;\n`;
  execFileSync("sqlite3", [COPILOT_DB, sql], { stdio: "inherit" });
  installCopilotExtension();
  console.log(`installed provider ${PROVIDER_NAME}`);
  console.log(`baseUrl=${baseUrl}`);
  console.log(`wireApi=responses`);
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

function installTargetForSubscription(subscriptionName, targetId) {
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

const args = GLOBAL_ARGS.args;
const command = args[0] || "status";
if (command === "serve") {
  if (!SUB_NAME) throw new Error("Use --sub <name> serve");
  startServer();
}
else if (command === "start") await startCommand();
else if (command === "stop") stopCommand();
else if (command === "status") await statusCommand();
else if (command === "enable") await enableCommand();
else if (command === "login") loginCommand();
else if (command === "logout") logoutCommand();
else if (command === "doctor") await doctorCommand();
else if (command === "check" || command === "probe") await checkCommand();
else if (command === "models") modelsCommand();
else if (command === "config") await configCommand(args.slice(1));
else if (command === "targets") targetsCommand();
else if (command === "install") installTarget(args[1]);
else if (command === "install-copilot") installTarget("copilot");
else if (command === "help" || command === "--help" || command === "-h") usage(0);
else usage(1);
