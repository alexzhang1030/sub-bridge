#!/usr/bin/env node
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform, release, arch } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { cursorAbout, makeCursorEnv, runCursorAcpTurn } from "./cursor-acp.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_RESPONSES_PATH = "/codex/responses";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

const CLI_NAME = "sub-bridge";

function envValue(...keys) {
  for (const key of keys) {
    if (process.env[key] !== undefined) return process.env[key];
  }
  return undefined;
}

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

const CONFIG = readConfigFile();

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

const AUTH_PATH =
  configValue("authPath", ["SUB_BRIDGE_AUTH_PATH", "CODEXSUB_AUTH_PATH"], join(homedir(), ".codex", "auth.json"));
const COPILOT_DB =
  configValue("copilotDb", ["SUB_BRIDGE_COPILOT_DB", "CODEXSUB_COPILOT_DB"], join(homedir(), ".copilot", "data.db"));
const HOST = configValue("host", ["SUB_BRIDGE_HOST", "CODEXSUB_HOST"], "127.0.0.1");
const PORT = configNumber("port", ["SUB_BRIDGE_PORT", "CODEXSUB_PORT"], 17876);
const DEFAULT_MODEL = configValue("model", ["SUB_BRIDGE_MODEL", "CODEXSUB_MODEL"], "gpt-5.5");
const BACKEND = configValue("backend", ["SUB_BRIDGE_BACKEND"], "codex");
const BRIDGE_KEY = configValue("bridgeKey", ["SUB_BRIDGE_KEY", "CODEXSUB_BRIDGE_KEY"], "");
const ORIGINATOR = configValue("originator", ["SUB_BRIDGE_ORIGINATOR", "CODEXSUB_ORIGINATOR"], "pi");
const PROVIDER_ID = configValue(
  "providerId",
  ["SUB_BRIDGE_PROVIDER_ID", "CODEXSUB_PROVIDER_ID"],
  "codexsub-openai-codex",
);
const PROVIDER_NAME = configValue("providerName", ["SUB_BRIDGE_PROVIDER_NAME", "CODEXSUB_PROVIDER_NAME"], "SubBridge");
const LEGACY_STATE_DIR = join(homedir(), ".local", "state", "gpt-sub-bridge");
const DEFAULT_STATE_DIR = join(homedir(), ".local", "state", "sub-bridge-cli");
const USE_LEGACY_STATE = existsSync(join(LEGACY_STATE_DIR, "gpt-sub-bridge.pid"));
const STATE_DIR =
  configValue("stateDir", ["SUB_BRIDGE_STATE_DIR", "CODEXSUB_STATE_DIR"], USE_LEGACY_STATE ? LEGACY_STATE_DIR : DEFAULT_STATE_DIR);
const PID_FILE_NAME = USE_LEGACY_STATE && STATE_DIR === LEGACY_STATE_DIR ? "gpt-sub-bridge.pid" : "sub-bridge.pid";
const LOG_FILE_NAME = USE_LEGACY_STATE && STATE_DIR === LEGACY_STATE_DIR ? "gpt-sub-bridge.log" : "sub-bridge.log";
const PID_PATH = configValue("pidPath", ["SUB_BRIDGE_PID_PATH", "CODEXSUB_PID_PATH"], join(STATE_DIR, PID_FILE_NAME));
const LOG_PATH = configValue("logPath", ["SUB_BRIDGE_LOG_PATH", "CODEXSUB_LOG_PATH"], join(STATE_DIR, LOG_FILE_NAME));
const REASONING_EFFORT =
  configValue(
    "reasoningEffort",
    ["SUB_BRIDGE_REASONING_EFFORT", "GPT_SUB_BRIDGE_REASONING_EFFORT", "CODEXSUB_REASONING_EFFORT"],
    "xhigh",
  );
const USE_PI_SETTING = String(
  configValue("usePi", ["SUB_BRIDGE_USE_PI", "GPT_SUB_BRIDGE_USE_PI", "CODEXSUB_USE_PI"], "1"),
).toLowerCase();
const USE_PI_WRAPPER = !["0", "false", "no", "off"].includes(USE_PI_SETTING);
const LEGACY_PI_RUNTIME_DIR = join(homedir(), ".local", "share", "gpt-sub-bridge");
const PI_RUNTIME_DIR =
  configValue(
    "piDir",
    ["SUB_BRIDGE_PI_DIR", "GPT_SUB_BRIDGE_PI_DIR"],
    existsSync(LEGACY_PI_RUNTIME_DIR) ? LEGACY_PI_RUNTIME_DIR : join(homedir(), ".local", "share", "sub-bridge-cli"),
  );
const PI_TRANSPORT = configValue("piTransport", ["SUB_BRIDGE_PI_TRANSPORT", "GPT_SUB_BRIDGE_PI_TRANSPORT"], "auto");
const PI_TIMEOUT_MS = configNumber("timeoutMs", ["SUB_BRIDGE_TIMEOUT_MS", "GPT_SUB_BRIDGE_TIMEOUT_MS"], 600000);
const STRIP_TOOLS_SETTING = String(
  configValue(
    "stripTools",
    ["SUB_BRIDGE_STRIP_TOOLS", "GPT_SUB_BRIDGE_STRIP_TOOLS", "CODEXSUB_STRIP_TOOLS"],
    USE_PI_WRAPPER ? "0" : "1",
  ),
).toLowerCase();
const STRIP_COPILOT_TOOLS = !["0", "false", "no", "off"].includes(STRIP_TOOLS_SETTING);
const BASE_URL = `http://${HOST}:${PORT}/v1`;
const HEALTH_URL = `http://${HOST}:${PORT}/healthz`;
const CURSOR_ACP_COMMAND = configValue(
  "cursorAcpCommand",
  ["SUB_BRIDGE_CURSOR_ACP_COMMAND"],
  "agent",
);
const CURSOR_API_ENDPOINT = configValue("cursorApiEndpoint", ["SUB_BRIDGE_CURSOR_API_ENDPOINT"], "");
const CURSOR_WORKSPACE = configValue("cursorWorkspace", ["SUB_BRIDGE_CURSOR_WORKSPACE"], process.cwd());
const CURSOR_MODEL = configValue("cursorModel", ["SUB_BRIDGE_CURSOR_MODEL"], "default");
const CURSOR_ACP_TIMEOUT_MS = configNumber(
  "cursorAcpTimeoutMs",
  ["SUB_BRIDGE_CURSOR_ACP_TIMEOUT_MS"],
  600000,
);
const CURSOR_FORCE_CI_SETTING = String(
  configValue("cursorForceCi", ["SUB_BRIDGE_CURSOR_FORCE_CI"], "1"),
).toLowerCase();
const CURSOR_FORCE_CI = !["0", "false", "no", "off"].includes(CURSOR_FORCE_CI_SETTING);
let piRuntimePromise = null;

function logLine(message, fields = {}) {
  const suffix = Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
  console.log(`${new Date().toISOString()} ${message}${suffix}`);
}

const MODELS = [
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

function usage(exitCode = 0) {
  console.log(`Usage:
  ${CLI_NAME} status
  ${CLI_NAME} login
  ${CLI_NAME} logout
  ${CLI_NAME} check
  ${CLI_NAME} start
  ${CLI_NAME} stop
  ${CLI_NAME} models
  ${CLI_NAME} config show
  ${CLI_NAME} config init
  ${CLI_NAME} config set <key> <value>
  ${CLI_NAME} targets
  ${CLI_NAME} install copilot

Aliases:
  serve = start
  probe = check
  install-copilot = install copilot

Environment:
  SUB_BRIDGE_CONFIG=${CONFIG_PATH}
  SUB_BRIDGE_PORT=17876
  SUB_BRIDGE_HOST=127.0.0.1
  SUB_BRIDGE_MODEL=gpt-5.5
  SUB_BRIDGE_BACKEND=codex|cursor-acp
  SUB_BRIDGE_AUTH_PATH=${AUTH_PATH}
  SUB_BRIDGE_KEY=optional-local-key
  SUB_BRIDGE_COPILOT_DB=${COPILOT_DB}
  SUB_BRIDGE_STATE_DIR=${STATE_DIR}
  SUB_BRIDGE_STRIP_TOOLS=0
  SUB_BRIDGE_REASONING_EFFORT=xhigh
  SUB_BRIDGE_USE_PI=1
  SUB_BRIDGE_PI_DIR=${PI_RUNTIME_DIR}
  SUB_BRIDGE_PI_TRANSPORT=auto
  SUB_BRIDGE_CURSOR_ACP_COMMAND=${CURSOR_ACP_COMMAND}
  SUB_BRIDGE_CURSOR_WORKSPACE=${CURSOR_WORKSPACE}
  SUB_BRIDGE_CURSOR_MODEL=${CURSOR_MODEL}
`);
  process.exit(exitCode);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
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
  const piStream = provider.stream(model, context, {
    apiKey: token,
    reasoningEffort: REASONING_EFFORT,
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

function normalizeRequestBody(bodyText) {
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
  if (REASONING_EFFORT) {
    const currentReasoning =
      body.reasoning && typeof body.reasoning === "object" && !Array.isArray(body.reasoning)
        ? body.reasoning
        : {};
    body.reasoning = { ...currentReasoning, effort: REASONING_EFFORT };
  }

  const strippedParams = [];
  if (Object.prototype.hasOwnProperty.call(body, "max_output_tokens")) {
    delete body.max_output_tokens;
    strippedParams.push("max_output_tokens");
  }

  const toolsIn = Array.isArray(body.tools) ? body.tools.length : 0;
  let strippedTools = false;
  if (STRIP_COPILOT_TOOLS && toolsIn > 0) {
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
    reasoningEffort: REASONING_EFFORT,
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
      reasoningEffort: REASONING_EFFORT,
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

  let finalMessage = null;
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
    logLine("responses.stream_error", {
      status: upstream.status,
      model: normalized.info.model,
      totalMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error),
    });
  });
  upstreamStream.pipe(res);
}

async function forwardResponsesCursorAcp(req, res, bodyText) {
  const startedAt = Date.now();
  const normalized = normalizeRequestBody(bodyText);
  const body = JSON.parse(normalized.body);
  const responseId = `resp_${randomUUID().replace(/-/g, "")}`;
  const output = [];
  const actualCursorModel = CURSOR_MODEL === "request" ? body.model : CURSOR_MODEL;

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
    reasoningEffort: REASONING_EFFORT,
    runtime: "cursor-acp",
    command: CURSOR_ACP_COMMAND,
    workspace: CURSOR_WORKSPACE,
  });

  const runOptionsBase = {
    command: CURSOR_ACP_COMMAND,
    apiEndpoint: CURSOR_API_ENDPOINT || undefined,
    workspace: CURSOR_WORKSPACE,
    env: makeCursorEnv({ forceCi: CURSOR_FORCE_CI }),
    timeoutMs: CURSOR_ACP_TIMEOUT_MS,
    model: actualCursorModel,
    reasoningEffort: REASONING_EFFORT,
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
    const item = {
      id: `msg_${randomUUID().replace(/-/g, "")}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: result.text, annotations: [] }],
    };
    output.push(item);
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

  const outputIndex = 0;
  const itemId = `msg_${randomUUID().replace(/-/g, "")}`;
  const item = {
    id: itemId,
    type: "message",
    status: "in_progress",
    role: "assistant",
    content: [],
  };
  const part = { type: "output_text", text: "", annotations: [] };
  output.push(item);

  recordWrite("response.created", {
    response: responseObject({ id: responseId, model: body.model, output }),
  });
  recordWrite("response.output_item.added", { output_index: outputIndex, item });
  item.content.push(part);
  recordWrite("response.content_part.added", {
    item_id: itemId,
    output_index: outputIndex,
    content_index: 0,
    part,
  });

  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const result = await runCursorAcpTurn({
      ...runOptionsBase,
      signal: controller.signal,
      onDelta: (delta) => {
        part.text += delta;
        recordWrite("response.output_text.delta", {
          item_id: itemId,
          output_index: outputIndex,
          content_index: 0,
          delta,
        });
      },
    });
    item.status = "completed";
    recordWrite("response.output_text.done", {
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      text: part.text || result.text,
    });
    if (!part.text && result.text) part.text = result.text;
    recordWrite("response.content_part.done", {
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part,
    });
    recordWrite("response.output_item.done", { output_index: outputIndex, item });
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
    const message = error instanceof Error ? error.message : String(error);
    item.status = "incomplete";
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
  if (BACKEND === "cursor-acp" || BACKEND === "cursor") {
    return forwardResponsesCursorAcp(req, res, bodyText);
  }
  if (USE_PI_WRAPPER) {
    return forwardResponsesPi(req, res, bodyText);
  }
  return forwardResponsesRaw(req, res, bodyText);
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
        if (BACKEND === "cursor-acp" || BACKEND === "cursor") {
          const about = cursorAbout({
            command: CURSOR_ACP_COMMAND,
            env: makeCursorEnv({ forceCi: CURSOR_FORCE_CI }),
            timeoutMs: 8000,
          });
          json(res, 200, {
            ok: true,
            provider: PROVIDER_NAME,
            runtime: "cursor-acp",
            backend: BACKEND,
            default_model: DEFAULT_MODEL,
            cursor_command: CURSOR_ACP_COMMAND,
            cursor_workspace: CURSOR_WORKSPACE,
            cursor_model: CURSOR_MODEL,
            cursor: about,
          });
          return;
        }
        const { accountId } = await loadCodexAuth();
        json(res, 200, {
          ok: true,
          provider: PROVIDER_NAME,
          runtime: USE_PI_WRAPPER ? "pi" : "direct",
          backend: BACKEND,
          pi_runtime_dir: USE_PI_WRAPPER ? PI_RUNTIME_DIR : null,
          pi_transport: USE_PI_WRAPPER ? PI_TRANSPORT : null,
          default_model: DEFAULT_MODEL,
          account_id_present: Boolean(accountId),
        });
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
    console.log(`backend: ${BACKEND}`);
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
  const pid = readPid();
  const pidRunning = pid ? isPidRunning(pid) : false;
  let health = null;
  try {
    health = await fetchJson(HEALTH_URL);
  } catch {}

  const running = Boolean(pidRunning || health?.ok);
  console.log(JSON.stringify({
    running,
    pid: pidRunning ? pid : null,
    base_url: BASE_URL,
    wire_api: "responses",
    backend: BACKEND,
    default_model: DEFAULT_MODEL,
    cursor_model: BACKEND === "cursor-acp" || BACKEND === "cursor" ? CURSOR_MODEL : null,
    health: health?.body || null,
    pid_path: PID_PATH,
    log_path: LOG_PATH,
  }, null, 2));
}

async function startCommand() {
  ensureStateDir();
  const pid = readPid();
  if (pid && isPidRunning(pid)) {
    console.log(`already running pid=${pid}`);
    return;
  }

  removePidFile();
  const out = openSync(LOG_PATH, "a", 0o600);
  const child = spawn(process.execPath, [process.argv[1], "serve"], {
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.unref();
  writeFileSync(PID_PATH, `${child.pid}\n`, { mode: 0o600 });
  console.log(`started pid=${child.pid}`);
  console.log(`base_url=${BASE_URL}`);
  console.log(`backend=${BACKEND}`);
  console.log(`log=${LOG_PATH}`);
}

function stopCommand() {
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

function loginCommand() {
  const result =
    BACKEND === "cursor-acp" || BACKEND === "cursor"
      ? spawnSync(CURSOR_ACP_COMMAND, ["login"], {
          stdio: "inherit",
          env: makeCursorEnv({ forceCi: CURSOR_FORCE_CI }),
        })
      : spawnSync("codex", ["login"], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
}

function logoutCommand() {
  stopCommand();
  const result =
    BACKEND === "cursor-acp" || BACKEND === "cursor"
      ? spawnSync(CURSOR_ACP_COMMAND, ["logout"], {
          stdio: "inherit",
          env: makeCursorEnv({ forceCi: CURSOR_FORCE_CI }),
        })
      : spawnSync("codex", ["logout"], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
}

function modelsCommand() {
  console.log(JSON.stringify(modelsResponse(), null, 2));
}

const CONFIG_SCHEMA = new Map([
  ["host", "string"],
  ["port", "number"],
  ["model", "string"],
  ["backend", "string"],
  ["authPath", "string"],
  ["copilotDb", "string"],
  ["bridgeKey", "string"],
  ["originator", "string"],
  ["providerId", "string"],
  ["providerName", "string"],
  ["stateDir", "string"],
  ["pidPath", "string"],
  ["logPath", "string"],
  ["reasoningEffort", "string"],
  ["usePi", "boolean"],
  ["piDir", "string"],
  ["piTransport", "string"],
  ["timeoutMs", "number"],
  ["stripTools", "boolean"],
  ["cursorAcpCommand", "string"],
  ["cursorApiEndpoint", "string"],
  ["cursorWorkspace", "string"],
  ["cursorModel", "string"],
  ["cursorAcpTimeoutMs", "number"],
  ["cursorForceCi", "boolean"],
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
  return String(value);
}

function configTemplate() {
  return {
    host: HOST,
    port: PORT,
    model: DEFAULT_MODEL,
    backend: BACKEND,
    reasoningEffort: REASONING_EFFORT,
    usePi: USE_PI_WRAPPER,
    piDir: PI_RUNTIME_DIR,
    piTransport: PI_TRANSPORT,
    timeoutMs: PI_TIMEOUT_MS,
    stripTools: STRIP_COPILOT_TOOLS,
    cursorAcpCommand: CURSOR_ACP_COMMAND,
    cursorApiEndpoint: CURSOR_API_ENDPOINT,
    cursorWorkspace: CURSOR_WORKSPACE,
    cursorModel: CURSOR_MODEL,
    cursorAcpTimeoutMs: CURSOR_ACP_TIMEOUT_MS,
    cursorForceCi: CURSOR_FORCE_CI,
    authPath: AUTH_PATH,
    copilotDb: COPILOT_DB,
  };
}

function redactedConfig(value) {
  const copy = { ...value };
  if (copy.bridgeKey) copy.bridgeKey = "<redacted>";
  return copy;
}

function effectiveConfig() {
  return {
    host: HOST,
    port: PORT,
    model: DEFAULT_MODEL,
    backend: BACKEND,
    authPath: AUTH_PATH,
    copilotDb: COPILOT_DB,
    bridgeKeyPresent: Boolean(BRIDGE_KEY),
    originator: ORIGINATOR,
    providerId: PROVIDER_ID,
    providerName: PROVIDER_NAME,
    stateDir: STATE_DIR,
    pidPath: PID_PATH,
    logPath: LOG_PATH,
    reasoningEffort: REASONING_EFFORT,
    usePi: USE_PI_WRAPPER,
    piDir: PI_RUNTIME_DIR,
    piTransport: PI_TRANSPORT,
    timeoutMs: PI_TIMEOUT_MS,
    stripTools: STRIP_COPILOT_TOOLS,
    cursorAcpCommand: CURSOR_ACP_COMMAND,
    cursorApiEndpoint: CURSOR_API_ENDPOINT,
    cursorWorkspace: CURSOR_WORKSPACE,
    cursorModel: CURSOR_MODEL,
    cursorAcpTimeoutMs: CURSOR_ACP_TIMEOUT_MS,
    cursorForceCi: CURSOR_FORCE_CI,
    baseUrl: BASE_URL,
  };
}

function writeConfigFile(config) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function configCommand(args) {
  const action = args[0] || "show";
  if (action === "path") {
    console.log(CONFIG_PATH);
    return;
  }
  if (action === "show") {
    console.log(JSON.stringify({
      configPath: CONFIG_PATH,
      exists: existsSync(CONFIG_PATH),
      file: redactedConfig(CONFIG),
      effective: effectiveConfig(),
    }, null, 2));
    return;
  }
  if (action === "init") {
    const nextConfig = { ...configTemplate(), ...CONFIG };
    writeConfigFile(nextConfig);
    console.log(`wrote ${CONFIG_PATH}`);
    return;
  }
  if (action === "get") {
    const key = args[1];
    if (!CONFIG_SCHEMA.has(key)) throw new Error(`Unknown config key: ${key}`);
    const value = effectiveConfig()[key] ?? CONFIG[key] ?? null;
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (action === "set") {
    const [key, ...rest] = args.slice(1);
    if (!key || rest.length === 0) throw new Error("Usage: sub-bridge config set <key> <value>");
    const value = parseConfigInput(key, rest.join(" "));
    writeConfigFile({ ...CONFIG, [key]: value });
    console.log(`set ${key}`);
    return;
  }
  if (action === "unset") {
    const key = args[1];
    if (!CONFIG_SCHEMA.has(key)) throw new Error(`Unknown config key: ${key}`);
    const nextConfig = { ...CONFIG };
    delete nextConfig[key];
    writeConfigFile(nextConfig);
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

function installTarget(targetId = "copilot") {
  const target = TARGETS.find((item) => item.id === targetId);
  if (!target) {
    console.error(`Unknown target: ${targetId}`);
    targetsCommand();
    process.exitCode = 1;
    return;
  }
  target.install();
}

const args = process.argv.slice(2);
const command = args[0] || "status";
if (command === "serve") startServer();
else if (command === "start") await startCommand();
else if (command === "stop") stopCommand();
else if (command === "status") await statusCommand();
else if (command === "login") loginCommand();
else if (command === "logout") logoutCommand();
else if (command === "check" || command === "probe") await checkCommand();
else if (command === "models") modelsCommand();
else if (command === "config") configCommand(args.slice(1));
else if (command === "targets") targetsCommand();
else if (command === "install") installTarget(args[1]);
else if (command === "install-copilot") installTarget("copilot");
else if (command === "help" || command === "--help" || command === "-h") usage(0);
else usage(1);
