#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "src/cli.ts"), "utf8");
const lines = source.split("\n");

const MODULES = {
  "models/registry.ts": { start: 360, end: 482 },
  "lib/http.ts": { names: ["readJson", "writeJson", "ensurePrivateDir", "requireBridgeAuth", "readRequestBody", "json", "logPrefix"] },
  "auth/cursor-local.ts": {
    names: ["readOrCreateCursorAuthKey", "saveCursorAuthToken", "loadCursorAuthToken", "cursorAuthTokenPresent", "removeCursorAuthToken", "cursorLocalEnvDirs", "makeBridgeCursorEnv", "makeCursorRuntimeEnv"],
  },
  "auth/codex-oauth.ts": {
    names: ["decodeBase64Url", "decodeJwtPayload", "extractAccountId", "tokenExpiresSoon", "refreshAccessToken", "loadCodexAuth"],
  },
  "wire/sse.ts": {
    names: ["formatResponsesSseEvent", "sseWrite", "beginResponsesSseStream", "flushResponsesSseStream", "createSseRecorder", "emitResponseInProgress", "sseDone", "responseObject", "normalizeResponseUsage"],
  },
  "wire/normalize.ts": {
    names: ["normalizeModelId", "requestWantsEventStream", "requestCopilotStainlessStreamHelper", "requestUsesCopilotNativeStream", "normalizeRequestBody", "codexHeaders"],
  },
  "wire/pi-context.ts": {
    names: ["loadPiRuntime", "emptyUsage", "parseJsonObject", "textFromResponsesContent", "imageFromResponsesPart", "userContentFromResponsesContent", "normalizeToolCallIds", "convertResponsesToolsToPi", "responsesBodyToPiContext", "collectPiResponse"],
  },
  "wire/completions.ts": {
    names: ["textFromChatMessageContent", "chatCompletionsBodyToResponsesBody", "chatMessageFromResponsesOutput", "chatCompletionObject", "formatChatCompletionSseChunk"],
  },
  "wire/copilot-tools.ts": {
    names: ["resolveCursorAcpModel", "safeToolIdentifier", "cursorToolKind", "cursorToolName", "cursorToolArguments", "cursorToolStatusIsTerminal", "cursorToolCallToFunctionCallItem", "cursorExtensionPayloadToFunctionCallItem", "copilotNativeToolCallToFunctionCallItem", "summarizeCopilotToolParameters", "normalizeCopilotFunctionCallArguments", "normalizeCopilotFunctionCallItem", "pushFunctionCallItem", "outputHasFunctionCalls", "stripCompanionAssistantMessagesWhenFunctionCalls", "allowedCopilotToolNames", "extractCopilotToolCallsFromText", "appendCursorJsonOutputFromEvents"],
  },
  "bridge/pi-forward.ts": { names: ["forwardResponsesPi"] },
  "bridge/raw-forward.ts": { names: ["forwardResponsesRaw"] },
  "bridge/cursor-responses-forward.ts": { names: ["forwardResponsesCursorAcp"] },
  "bridge/cursor-completions-forward.ts": { names: ["forwardChatCompletionsCursorAcp", "forwardChatCompletions", "forwardResponses"] },
  "server/http-server.ts": { names: ["modelsResponse", "startServer"] },
  "process/state-files.ts": {
    names: ["ensureStateDir", "readPid", "isPidRunning", "removePidFile", "allSubscriptionNames", "requireSubscriptions", "runSubscriptionCommand", "runSubscriptionCommandJson", "fetchJson"],
  },
  "commands/status.ts": { names: ["statusCommand", "runProbe", "commandProbe", "providerPluginContext", "codexAuthDoctor", "cursorAuthDoctor", "launchdDoctor", "copilotDoctor", "doctorCommand"] },
  "commands/lifecycle.ts": { names: ["startCommand", "enableCommand", "stopCommand"] },
  "commands/auth.ts": { names: ["loginCursor", "loginCodex", "loginCommand", "logoutCursor", "logoutCodex", "logoutCommand"] },
  "commands/models.ts": {
    names: ["modelsCommand", "modelsFromJson", "modelsFromText", "parseModelCommandOutput", "mergeFetchedModels", "mergeCursorDiscoveredModels", "mergeCursorCliModelSnapshot", "fetchCursorModelSnapshot", "fetchCursorModelCommandSnapshot", "fetchCodexModelSnapshot", "fetchModelSnapshot"],
  },
  "commands/config.ts": {
    names: ["parseConfigInput", "configTemplate", "redactedConfig", "effectiveConfig", "cursorModelsForGroupControl", "cursorGroupSummary", "resolveCursorModelGroupId", "resolveCursorModelGroupIds", "writeCursorModelGroupState", "writeCursorModelGroupOnly", "writeCursorModelGroupPreset", "resetCursorModelGroups", "writeConfigFile", "writeActiveConfigValue", "unsetActiveConfigValue", "writeSubscriptionConfig", "configCommand"],
  },
  "commands/check.ts": { names: ["extractOutputTextFromSse", "checkCommand"] },
  "copilot/install.ts": {
    names: ["sqlQuote", "repairCopilotWireApiSql", "repairCopilotWireApi", "copilotExtensionSource", "installCopilotExtension", "installCopilot", "targetsCommand", "installTargetForSubscription", "installTarget"],
  },
  "cli/usage.ts": { names: ["usage"] },
};

function extractFunction(name) {
  const fnRe = new RegExp(`^(async )?function ${name}\\(`);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (fnRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  let depth = 0;
  let started = false;
  for (let i = start; i < lines.length; i += 1) {
    for (const ch of lines[i]) {
      if (ch === "{") {
        depth += 1;
        started = true;
      } else if (ch === "}") depth -= 1;
    }
    if (started && depth === 0) return lines.slice(start, i + 1).join("\n");
  }
  return null;
}

function extractRange(start, end) {
  return lines.slice(start - 1, end).join("\n");
}

const RUNTIME_NAMES = new Set([
  "CONFIG","MODELS","DEFAULT_MODEL","PORT","HOST","SUB_NAME","CLI_NAME","PROVIDER_PLUGIN","PROVIDER_ID","PROVIDER_NAME",
  "CURSOR_ACP_COMMAND","CURSOR_API_ENDPOINT","CURSOR_WORKSPACE","CURSOR_MODEL","CURSOR_ACP_TIMEOUT_MS","CURSOR_FORCE_CI",
  "CURSOR_LOCAL_AUTH_DIR","CURSOR_LOCAL_AUTH_KEY_PATH","CURSOR_LOCAL_AUTH_TOKEN_PATH","COPILOT_DB","COPILOT_EXTENSION_DIR",
  "COPILOT_EXTENSION_NAME","COPILOT_SSE_DATA_ONLY","STRIP_COPILOT_TOOLS","SYNC_RESPONSES","BASE_URL","HEALTH_URL",
  "AUTH_PATH","STATE_DIR","PID_PATH","LOG_PATH","BACKEND","USE_PI_WRAPPER","PI_RUNTIME_DIR","PI_TRANSPORT","PI_TIMEOUT_MS",
  "BRIDGE_KEY","ORIGINATOR","REASONING_EFFORT","OFFLINE_DISCOVERY","BUILTIN_MODELS","DEFAULT_MODEL_OVERRIDE","CONFIG_PATH",
  "CONFIG_FILE","GLOBAL_ARGS","CLIENT_ID","TOKEN_URL","JWT_CLAIM_PATH","DEFAULT_CODEX_BASE_URL","CODEX_RESPONSES_PATH",
  "piRuntimePromise","logLine","envValue","slug","subEnvKey","envKeysForSub","readConfigFile","configValue","configNumber",
  "configBoolean","subscriptionsFromConfig","configDocument","normalizeSubscriptionConfig","isPlainObject","TARGETS",
]);

function moduleHeader(body, relPath) {
  const parts = [];
  const used = [...RUNTIME_NAMES].filter((n) => new RegExp(`\\b${n}\\b`).test(body));
  if (used.length > 0) {
    parts.push(`import { getRuntime } from "../runtime/context.js";`);
    parts.push(`const { ${used.join(", ")} } = getRuntime();`);
  }
  const needsHttp = /IncomingMessage|ServerResponse|createServer/.test(body) || relPath.startsWith("bridge/") || relPath.startsWith("server/");
  if (needsHttp) parts.unshift(`import type { IncomingMessage, ServerResponse } from "node:http";`);
  if (/createServer/.test(body)) parts.unshift(`import { createServer } from "node:http";`);
  if (/Readable/.test(body)) parts.unshift(`import { Readable } from "node:stream";`);
  if (/execFileSync|spawn/.test(body)) parts.unshift(`import { execFileSync, spawn, spawnSync } from "node:child_process";`);
  if (/readFileSync|writeFileSync|existsSync|mkdirSync/.test(body)) {
    parts.unshift(`import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";`);
  }
  if (/randomUUID|createCipheriv/.test(body)) parts.unshift(`import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";`);
  if (/homedir|platform/.test(body)) parts.unshift(`import { homedir, platform, release, arch } from "node:os";`);
  if (/join\(/.test(body)) parts.unshift(`import { dirname, join } from "node:path";`);
  if (/pathToFileURL/.test(body)) parts.unshift(`import { pathToFileURL } from "node:url";`);
  if (/runCursorAcpTurn|cursorAbout|fetchCursorAcpModels|shutdownCursorAcpRuntimes/.test(body)) {
    parts.unshift(`import { cursorAbout, fetchCursorAcpModels, makeCursorEnv, runCursorAcpTurn, shutdownCursorAcpRuntimes } from "../../cursor-acp.js";`);
  }
  if (/mergeCursorAcpToolCallState/.test(body)) parts.unshift(`import { mergeCursorAcpToolCallState } from "../../cursor-acp-event-processor.js";`);
  if (/defaultCursorAcpCommand|makeCursorProbeEnv|makeCursorEnv/.test(body) && !/from "\.\.\/\.\.\/cursor-acp/.test(parts.join("\n"))) {
    parts.unshift(`import { defaultCursorAcpCommand, makeCursorProbeEnv } from "../../cursor-runtime.js";`);
  }
  if (/errorMessage|isAbortLikeError|isRetryableTransientError/.test(body)) {
    parts.unshift(`import { errorMessage, isAbortLikeError, isRetryableTransientError } from "../../errors.js";`);
  }
  if (/providerPluginForType|defaultProviderPort/.test(body)) {
    parts.unshift(`import { defaultProviderId as defaultPluginProviderId, defaultProviderName as defaultPluginProviderName, defaultProviderPort, defaultProviderTypeForSub, providerPluginForType } from "../../provider-plugins.js";`);
  }
  if (/cursorOptionsFromModelEntry|resolveReasoningEffortForModel/.test(body)) {
    parts.unshift(`import { cursorOptionsFromModelEntry, filterCursorModelsByGroups, mergeCursorModelVariantsWithBaseControls, mergeCursorModelOptions, normalizeModelGroupsConfig, parseCursorCliModelList, resolveReasoningEffortForModel, summarizeCursorModelGroups, stripCursorParameterizedSuffix } from "../../cursor-models.js";`);
  }
  return `${[...new Set(parts)].join("\n")}\n\n`;
}

const outDir = join(root, "src/app");
mkdirSync(outDir, { recursive: true });

const bootstrapBody = extractRange(42, 358);
const bootstrapExtra = extractRange(436, 461);
const runtimeFile = `import { homedir } from "node:os";
import { join } from "node:path";
import { defaultCursorAcpCommand } from "../cursor-runtime.js";
import { defaultProviderId as defaultPluginProviderId, defaultProviderName as defaultPluginProviderName, defaultProviderPort, defaultProviderTypeForSub, providerPluginForType } from "../provider-plugins.js";
import { filterCursorModelsByGroups, mergeCursorModelVariantsWithBaseControls, mergeCursorModelOptions, cursorOptionsFromModelEntry, resolveReasoningEffortForModel, stripCursorParameterizedSuffix } from "../cursor-models.js";

${bootstrapBody}

${bootstrapExtra}

export function createBridgeRuntime() {
  const MODELS = activeModels();
  const DEFAULT_MODEL = defaultModelFromModels();
  return {
    CLIENT_ID, TOKEN_URL, DEFAULT_CODEX_BASE_URL, CODEX_RESPONSES_PATH, JWT_CLAIM_PATH, CLI_NAME, CONFIG_VERSION, CONFIG_SCHEMA_URL,
    GLOBAL_ARGS, SUB_NAME, CONFIG_PATH, CONFIG_FILE, CONFIG, BACKEND, PROVIDER_PLUGIN, AUTH_PATH, COPILOT_DB, COPILOT_EXTENSION_NAME,
    COPILOT_EXTENSION_DIR, HOST, PORT, DEFAULT_MODEL_OVERRIDE, BRIDGE_KEY, ORIGINATOR, PROVIDER_ID, PROVIDER_NAME, STATE_DIR, PID_PATH,
    LOG_PATH, REASONING_EFFORT, USE_PI_WRAPPER, PI_RUNTIME_DIR, PI_TRANSPORT, PI_TIMEOUT_MS, STRIP_COPILOT_TOOLS, SYNC_RESPONSES,
    COPILOT_SSE_DATA_ONLY, BASE_URL, HEALTH_URL, CURSOR_ACP_COMMAND, CURSOR_API_ENDPOINT, CURSOR_WORKSPACE, CURSOR_MODEL, CURSOR_ACP_TIMEOUT_MS,
    CURSOR_FORCE_CI, OFFLINE_DISCOVERY, CURSOR_LOCAL_AUTH_DIR, CURSOR_LOCAL_AUTH_KEY_PATH, CURSOR_LOCAL_AUTH_TOKEN_PATH, piRuntimePromise,
    BUILTIN_MODELS, MODELS, DEFAULT_MODEL, logLine, envValue, parseGlobalArgs, slug, subEnvKey, envKeysForSub, readConfigFile, configValue,
    configNumber, configBoolean, subscriptionsFromConfig, configDocument, normalizeSubscriptionConfig, isPlainObject, normalizeModelEntry,
    normalizeModelList, activeModels, defaultModelFromModels, modelConfigFor, reasoningEffortForModel, cursorOptionsForModel,
  };
}

let runtime: ReturnType<typeof createBridgeRuntime> | null = null;

export function initRuntime() {
  runtime = createBridgeRuntime();
  return runtime;
}

export function getRuntime() {
  if (!runtime) throw new Error("Bridge runtime not initialized");
  return runtime;
}
`;

writeFileSync(join(outDir, "runtime/context.ts"), runtimeFile);

for (const [relPath, spec] of Object.entries(MODULES)) {
  const chunks = [];
  if (spec.start && spec.end) chunks.push(extractRange(spec.start, spec.end));
  if (spec.names) {
    for (const name of spec.names) {
      const body = extractFunction(name);
      if (!body) console.warn(`missing: ${name}`);
      else chunks.push(body);
    }
  }
  if (chunks.length === 0) continue;
  const body = chunks.join("\n\n");
  const exports = [];
  if (spec.names) {
    for (const name of spec.names) {
      if (body.includes(`function ${name}(`) || body.includes(`async function ${name}(`)) {
        exports.push(name);
      }
    }
  }
  const exportSuffix = exports.length > 0 ? `\n\nexport { ${exports.join(", ")} };\n` : "\n";
  const patched = body
    .replace(/^function /gm, "export function ")
    .replace(/^async function /gm, "export async function ");
  const target = join(outDir, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, moduleHeader(body, relPath) + patched + exportSuffix);
  console.log("wrote", relPath);
}
