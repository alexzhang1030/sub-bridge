// @ts-nocheck
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { makeCursorEnv } from "./cursor-runtime";
import {
  createCursorAcpEventProcessor,
  mergeCursorAcpToolCallState,
} from "./cursor-acp-event-processor";

import {
  collectCursorAcpConfigUpdates,
  modelSupportsAcpReasoningConfig,
  cursorModelsFromAvailableModels,
  cursorModelsFromConfigOptions,
  CURSOR_LIST_AVAILABLE_MODELS_METHOD,
  mergeCursorModelOptions,
  modelConfigId,
  resolveCursorAcpModelValue,
  validateCursorAcpModelValue,
} from "./cursor-models";

export { makeCursorEnv } from "./cursor-runtime";
export { mergeCursorAcpToolCallState } from "./cursor-acp-event-processor";
export { deriveToolActivityPresentation } from "./tool-activity";

const packageInfo = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const clientInfo = { name: "sub-bridge", version: String(packageInfo.version || "0.0.0") };

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function textFromContent(content) {
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

function imageFromPart(part) {
  if (!part || part.type !== "input_image") return null;
  const imageUrl = part.image_url?.url || part.image_url;
  if (typeof imageUrl !== "string") return null;
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(imageUrl);
  if (!match) return null;
  return { type: "image", mimeType: match[1], data: match[2] };
}

function appendContentBlocks(content, textParts, imageParts) {
  if (typeof content === "string") {
    if (content.trim()) textParts.push(content.trim());
    return;
  }
  if (!Array.isArray(content)) return;
  const localText = [];
  for (const item of content) {
    if (typeof item === "string") {
      localText.push(item);
      continue;
    }
    const image = imageFromPart(item);
    if (image) {
      imageParts.push(image);
    } else if (item?.type === "input_text" || item?.type === "text" || item?.type === "output_text") {
      if (typeof item.text === "string") localText.push(item.text);
    }
  }
  const text = localText.join("").trim();
  if (text) textParts.push(text);
}

function copilotToolDefinition(tool) {
  const source = tool?.function && typeof tool.function === "object" ? tool.function : tool;
  const name = typeof source?.name === "string" ? source.name.trim() : "";
  if (!name || name.startsWith("subbridge_cursor_")) return null;
  const description =
    typeof source?.description === "string" && source.description.trim()
      ? source.description.trim().slice(0, 240)
      : "";
  const params = summarizeCopilotToolParameters(source?.parameters);
  if (description) return `- ${name}: ${description}${params}`;
  return params ? `- ${name}${params}` : `- ${name}`;
}

function summarizeCopilotToolParameters(parameters) {
  if (!parameters || typeof parameters !== "object") return "";
  const required = Array.isArray(parameters.required) ? parameters.required : [];
  const properties =
    parameters.properties && typeof parameters.properties === "object" ? parameters.properties : {};
  const chunks = required.map((key) => {
    const schema = properties[key];
    const type = typeof schema?.type === "string" ? schema.type : "value";
    return `${key}:${type}`;
  });
  return chunks.length > 0 ? ` (requires ${chunks.join(", ")})` : "";
}

function appendCopilotToolsToPrompt(body, textParts) {
  const lines = [];
  for (const tool of Array.isArray(body?.tools) ? body.tools : []) {
    const line = copilotToolDefinition(tool);
    if (line) lines.push(line);
  }
  if (lines.length === 0) return;
  textParts.push(
    [
      "Copilot platform tools available to this session (do not execute these yourself; emit them for Copilot to run):",
      lines.join("\n"),
      "When you must call one of these Copilot tools, output a single line before your visible reply:",
      'COPILOT_FUNCTION_CALL: {"name":"<tool_name>","arguments":{...}}',
      "Use the exact parameter names from the tool list (e.g. rename_session uses title, not name).",
    ].join("\n"),
  );
}

export function responsesBodyToCursorPrompt(body) {
  const textParts = [];
  const imageParts = [];

  if (typeof body.instructions === "string" && body.instructions.trim()) {
    textParts.push(`Instructions:\n${body.instructions.trim()}`);
  }
  appendCopilotToolsToPrompt(body, textParts);

  const inputItems = Array.isArray(body.input)
    ? body.input
    : typeof body.input === "string"
      ? [{ role: "user", content: body.input }]
      : [];
  const hasCopilotToolResults = inputItems.some(
    (item) => isRecord(item) && item.type === "function_call_output",
  );
  if (hasCopilotToolResults) {
    textParts.push(
      [
        "Copilot already showed your previous assistant reply to the user.",
        "After the tool results above, do not repeat that reply.",
        "Only add new information or one brief acknowledgment if needed.",
      ].join(" "),
    );
  }

  const input = typeof body.input === "string" ? [{ role: "user", content: body.input }] : body.input;
  for (const item of Array.isArray(input) ? input : []) {
    if (!isRecord(item)) continue;
    const role = typeof item.role === "string" ? item.role : typeof item.type === "string" ? item.type : "input";

    if (item.type === "function_call") {
      const name = typeof item.name === "string" ? item.name : "tool";
      const args = typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {});
      textParts.push(`Assistant tool call ${name}:\n${args}`);
      continue;
    }

    if (item.type === "function_call_output") {
      const output = textFromContent(item.output ?? item.content).trim();
      if (output) textParts.push(`Tool result ${item.call_id ?? ""}:\n${output}`);
      continue;
    }

    const localText = [];
    appendContentBlocks(item.content, localText, imageParts);
    const text = localText.join("\n").trim();
    if (text) textParts.push(`${role}:\n${text}`);
  }

  const prompt = [];
  const text = textParts.join("\n\n").trim() || "Continue.";
  prompt.push({ type: "text", text });
  prompt.push(...imageParts);
  return prompt;
}

function trimNonEmpty(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

function usageFromAcpUsage(usage) {
  if (!isRecord(usage)) return null;
  const inputTokens = Number(usage.inputTokens ?? usage.input_tokens ?? 0) || 0;
  const outputTokens = Number(usage.outputTokens ?? usage.output_tokens ?? 0) || 0;
  const cachedTokens = Number(usage.cachedReadTokens ?? usage.cached_read_tokens ?? 0) || 0;
  const reasoningTokens = Number(usage.thoughtTokens ?? usage.reasoning_tokens ?? 0) || 0;
  const totalTokens = Number(usage.totalTokens ?? usage.total_tokens ?? inputTokens + outputTokens) || 0;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    input_tokens_details: { cached_tokens: cachedTokens },
    output_tokens_details: { reasoning_tokens: reasoningTokens },
  };
}

function errorFromJsonRpc(error) {
  const details = [];
  if (typeof error?.message === "string" && error.message) details.push(error.message);
  if (typeof error?.data?.message === "string" && error.data.message) details.push(error.data.message);
  const message = details.length > 0 ? details.join(": ") : JSON.stringify(error);
  const result = new Error(message);
  result.code = error?.code;
  result.data = error?.data;
  return result;
}

export class CursorAcpClient {
  constructor(options) {
    this.options = options;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.closed = false;
    this.child = null;
  }

  start() {
    const args = [
      ...(this.options.apiEndpoint ? ["-e", this.options.apiEndpoint] : []),
      "acp",
    ];
    this.child = spawn(this.options.command, args, {
      cwd: this.options.workspace,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.options.onStderr?.(chunk);
    });
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      this.rejectAll(new Error(`Cursor ACP exited code=${code ?? "null"} signal=${signal ?? "null"}`));
    });
  }

  handleStdout(chunk) {
    this.buffer += chunk;
    while (true) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) break;
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.options.onProtocolError?.(new Error(`Invalid Cursor ACP JSON: ${line.slice(0, 500)}`));
        continue;
      }
      this.handleMessage(message);
    }
  }

  deliverProcessorEvents(message) {
    const processor = this.options.eventProcessor;
    if (!processor) return;
    const delivered = processor.deliveredCount ?? 0;
    const all = processor.snapshot();
    for (let index = delivered; index < all.length; index += 1) {
      const event = all[index];
      this.options.onEvent?.(event, message);
      if (event.type === "content_delta" && event.streamKind === "assistant_text") {
        this.options.onDelta?.(event.text, message);
      }
    }
    processor.deliveredCount = all.length;
  }

  handleMessage(message) {
    if (message && Object.prototype.hasOwnProperty.call(message, "id") && message.method) {
      this.handleServerRequest(message);
      return;
    }
    if (message && Object.prototype.hasOwnProperty.call(message, "id")) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(errorFromJsonRpc(message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message?.method) {
      const processor = this.options.eventProcessor;
      if (processor) {
        processor.ingestMessage(message);
        this.deliverProcessorEvents(message);
      }
      this.options.onNotification?.(message);
    }
  }

  handleServerRequest(message) {
    const params = message.params || {};
    if (message.method === "session/request_permission") {
      const options = Array.isArray(params.options) ? params.options : [];
      const selected =
        options.find((option) => option.kind === "allow_always") ||
        options.find((option) => option.kind === "allow_once") ||
        options[0];
      if (selected?.optionId) {
        this.respond(message.id, { outcome: { outcome: "selected", optionId: selected.optionId } });
      } else {
        this.respond(message.id, { outcome: { outcome: "cancelled" } });
      }
      return;
    }
    const processor = this.options.eventProcessor;
    if (processor) {
      const result = processor.ingestExtensionRequest(message.method, params);
      if (result !== undefined) {
        this.deliverProcessorEvents(message);
        this.respond(message.id, result);
        return;
      }
    }
    this.respondError(message.id, -32601, `Method not found: ${message.method}`);
  }

  respond(id, result) {
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id, code, message) {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  request(method, params) {
    if (this.closed || !this.child?.stdin.writable) {
      return Promise.reject(new Error("Cursor ACP process is closed"));
    }
    const id = this.nextId++;
    const timeoutMs = this.options.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Cursor ACP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  write(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  cancelPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.pending.clear();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.cancelPending(new Error("Cursor ACP process is closed"));
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
      setTimeout(() => {
        if (this.child && !this.child.killed) this.child.kill("SIGKILL");
      }, 1500).unref();
    }
  }
}

async function setConfigOption(client, sessionId, configId, value) {
  const payload =
    typeof value === "boolean"
      ? { sessionId, configId, type: "boolean", value }
      : { sessionId, configId, value: String(value) };
  return client.request("session/set_config_option", payload);
}

export async function configureCursorSession(client, sessionId, sessionSetup, options) {
  let configOptions = Array.isArray(sessionSetup?.configOptions) ? sessionSetup.configOptions : [];
  const requestedModel = options.model && options.model !== "default" ? options.model : "auto";
  const modelOptions = mergeCursorModelOptions(
    options.modelOptions,
    options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : null,
  );
  const modelValue = resolveCursorAcpModelValue(configOptions, requestedModel, modelOptions);
  const validationError = validateCursorAcpModelValue(configOptions, modelValue);
  if (validationError) throw new Error(validationError);
  const acpModelOptions = { ...modelOptions };
  if (!modelSupportsAcpReasoningConfig(configOptions, modelValue)) {
    delete acpModelOptions.reasoningEffort;
  }
  if (modelValue) {
    const result = await setConfigOption(client, sessionId, modelConfigId(configOptions), modelValue);
    if (Array.isArray(result?.configOptions)) configOptions = result.configOptions;
  }

  for (const update of collectCursorAcpConfigUpdates(configOptions, acpModelOptions, modelValue)) {
    const result = await setConfigOption(client, sessionId, update.configId, update.value);
    if (Array.isArray(result?.configOptions)) configOptions = result.configOptions;
  }
  return configOptions;
}

async function runCursorAcpTurnEphemeral(options) {
  const textChunks = [];
  const copilotToolNames = options.copilotToolNames instanceof Set ? options.copilotToolNames : new Set();
  const eventProcessor = createCursorAcpEventProcessor({ copilotToolNames });
  eventProcessor.deliveredCount = 0;
  const client = new CursorAcpClient({
    ...options,
    eventProcessor,
    onEvent: (event, raw) => {
      options.onEvent?.(event, raw);
    },
    onDelta: (delta, raw) => {
      textChunks.push(delta);
      options.onDelta?.(delta, raw);
    },
  });
  const signal = options.signal;
  const abort = () => client.close();
  if (signal) {
    if (signal.aborted) throw new Error("Cursor ACP request aborted");
    signal.addEventListener("abort", abort, { once: true });
  }

  try {
    client.start();
    const initializeResult = await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        _meta: { parameterizedModelPicker: true },
      },
      clientInfo,
    });
    await client.request("authenticate", { methodId: "cursor_login" });
    const sessionSetup = await client.request("session/new", {
      cwd: options.workspace,
      mcpServers: [],
    });
    const sessionId = sessionSetup?.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error("Cursor ACP did not return a sessionId");
    }
    await configureCursorSession(client, sessionId, sessionSetup, options);
    const prompt = responsesBodyToCursorPrompt(options.body);
    const promptResult = await client.request("session/prompt", { sessionId, prompt });
    eventProcessor.flush();
    const events = eventProcessor.snapshot();
    const outputText = textChunks.join("");
    return {
      text: outputText,
      promptResult,
      initializeResult,
      events,
      usage: usageFromAcpUsage(promptResult?.usage),
      stopReason: promptResult?.stopReason || "completed",
    };
  } finally {
    if (signal) signal.removeEventListener("abort", abort);
    client.close();
  }
}

export async function runCursorAcpTurn(options) {
  if (cursorAcpPoolEnabled()) {
    return getCursorAcpRuntime(options).runTurn(options);
  }
  return runCursorAcpTurnEphemeral(options);
}

export async function fetchCursorAcpModels(options) {
  if (cursorAcpPoolEnabled()) {
    return getCursorAcpRuntime(options).fetchModels(options);
  }
  const client = new CursorAcpClient(options);
  try {
    client.start();
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        _meta: { parameterizedModelPicker: true },
      },
      clientInfo,
    });
    await client.request("authenticate", { methodId: "cursor_login" });
    const sessionSetup = await client.request("session/new", {
      cwd: options.workspace,
      mcpServers: [],
    });
    const sessionId = sessionSetup?.sessionId;
    if (typeof sessionId === "string" && sessionId) {
      try {
        const available = await client.request(CURSOR_LIST_AVAILABLE_MODELS_METHOD, { sessionId });
        const models = cursorModelsFromAvailableModels(available?.models);
        if (models.length > 0) return models;
      } catch (error) {
        options.onProtocolError?.(error);
      }
    }
    return cursorModelsFromConfigOptions(sessionSetup?.configOptions);
  } finally {
    client.close();
  }
}

export function cursorAbout({ command, env, timeoutMs = 8000 }) {
  const jsonResult = spawnSync(command, ["about", "--format", "json"], {
    env,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  const result =
    jsonResult.status === 0 && String(jsonResult.stdout || "").trim().startsWith("{")
      ? jsonResult
      : spawnSync(command, ["about"], { env, encoding: "utf8", timeout: timeoutMs });
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {}
  const combined = `${stdout}\n${stderr}`;
  const version =
    parsed?.cliVersion ||
    (/^CLI Version\s{2,}(.+)$/im.exec(combined)?.[1]?.trim()) ||
    null;
  const userEmail =
    parsed && Object.prototype.hasOwnProperty.call(parsed, "userEmail")
      ? parsed.userEmail
      : /^User Email\s{2,}(.+)$/im.exec(combined)?.[1]?.trim();
  const authenticated =
    typeof userEmail === "string" &&
    userEmail.trim() &&
    userEmail.trim().toLowerCase() !== "not logged in";
  return {
    ok: result.status === 0,
    status: result.status,
    version,
    authenticated: Boolean(authenticated),
    userEmail: authenticated ? userEmail.trim() : null,
    message: result.status === 0 ? null : (stderr || stdout).trim(),
  };
}

function cursorAcpPoolEnabled() {
  const value = String(process.env.SUB_BRIDGE_CURSOR_ACP_POOL ?? "1").trim().toLowerCase();
  return value !== "0" && value !== "false";
}

function cursorAcpSessionPoolSize() {
  const parsed = Number(process.env.SUB_BRIDGE_CURSOR_ACP_SESSION_POOL_SIZE ?? "1");
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), 4) : 1;
}

function cursorAcpRuntimeKey(options) {
  return [options.command, options.workspace, options.apiEndpoint || ""].join("\0");
}

const cursorAcpRuntimes = new Map();

class CursorAcpRuntime {
  constructor(options) {
    this.baseOptions = {
      command: options.command,
      workspace: options.workspace,
      env: options.env,
      apiEndpoint: options.apiEndpoint,
      timeoutMs: options.timeoutMs,
    };
    this.client = null;
    this.connectPromise = null;
    this.opQueue = Promise.resolve();
    this.configOptions = null;
    this.idleSessions = [];
    this.refillScheduled = false;
  }

  enqueue(task) {
    const run = this.opQueue.then(() => task(), () => task());
    this.opQueue = run.catch(() => {});
    return run;
  }

  async ensureConnected() {
    if (this.client && !this.client.closed) return this.client;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this._connect();
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async _connect() {
    const client = new CursorAcpClient({ ...this.baseOptions });
    client.start();
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        _meta: { parameterizedModelPicker: true },
      },
      clientInfo,
    });
    await client.request("authenticate", { methodId: "cursor_login" });
    this.client = client;
    await this._primeConfigOptions();
    this._scheduleSessionRefill();
    return client;
  }

  async _primeConfigOptions() {
    if (Array.isArray(this.configOptions) && this.configOptions.length > 0) return;
    const setup = await this._createSession();
    const sessionId = setup?.sessionId;
    const configOptions = Array.isArray(setup.configOptions) ? setup.configOptions : [];
    if (configOptions.length > 0) this.configOptions = configOptions;
    if (typeof sessionId === "string" && sessionId) {
      this.idleSessions.push({ sessionId, configOptions: this.configOptions || configOptions });
    }
  }

  async _createSession() {
    const client = await this.ensureConnected();
    return client.request("session/new", {
      cwd: this.baseOptions.workspace,
      mcpServers: [],
    });
  }

  _scheduleSessionRefill() {
    if (this.refillScheduled) return;
    this.refillScheduled = true;
    void this.enqueue(async () => {
      this.refillScheduled = false;
      const target = cursorAcpSessionPoolSize();
      while (this.idleSessions.length < target) {
        try {
          const setup = await this._createSession();
          const sessionId = setup?.sessionId;
          if (typeof sessionId !== "string" || !sessionId) break;
          this.idleSessions.push({
            sessionId,
            configOptions: Array.isArray(setup.configOptions) ? setup.configOptions : this.configOptions || [],
          });
          if (Array.isArray(setup.configOptions) && setup.configOptions.length > 0) {
            this.configOptions = setup.configOptions;
          }
        } catch {
          break;
        }
      }
    });
  }

  async _acquireSession() {
    await this.ensureConnected();
    const pooled = this.idleSessions.pop();
    if (pooled) {
      this._scheduleSessionRefill();
      return pooled;
    }
    const setup = await this._createSession();
    const sessionId = setup?.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error("Cursor ACP did not return a sessionId");
    }
    const configOptions = Array.isArray(setup.configOptions) ? setup.configOptions : this.configOptions || [];
    if (configOptions.length > 0) this.configOptions = configOptions;
    return { sessionId, configOptions };
  }

  _validateTurnOptions(options) {
    const configOptions = this.configOptions || [];
    const requestedModel = options.model && options.model !== "default" ? options.model : "auto";
    const modelOptions = mergeCursorModelOptions(
      options.modelOptions,
      options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : null,
    );
    const modelValue = resolveCursorAcpModelValue(configOptions, requestedModel, modelOptions);
    const validationError = validateCursorAcpModelValue(configOptions, modelValue);
    if (validationError) throw new Error(validationError);
    return { requestedModel, modelOptions, modelValue };
  }

  async runTurn(options) {
    return this.enqueue(async () => {
      const textChunks = [];
      const copilotToolNames = options.copilotToolNames instanceof Set ? options.copilotToolNames : new Set();
      const eventProcessor = createCursorAcpEventProcessor({ copilotToolNames });
      eventProcessor.deliveredCount = 0;
      const client = await this.ensureConnected();
      const priorHandlers = {
        eventProcessor: client.options.eventProcessor,
        onEvent: client.options.onEvent,
        onDelta: client.options.onDelta,
        onStderr: client.options.onStderr,
        onProtocolError: client.options.onProtocolError,
      };
      client.options.eventProcessor = eventProcessor;
      client.options.onEvent = (event, raw) => {
        options.onEvent?.(event, raw);
      };
      client.options.onDelta = (delta, raw) => {
        textChunks.push(delta);
        options.onDelta?.(delta, raw);
      };
      client.options.onStderr = options.onStderr;
      client.options.onProtocolError = options.onProtocolError;

      const signal = options.signal;
      const abortError = () => new Error("Cursor ACP request aborted");
      const abort = () => {
        if (!client.closed) client.cancelPending(abortError());
      };
      if (signal) {
        if (signal.aborted) throw abortError();
        signal.addEventListener("abort", abort, { once: true });
      }

      try {
        await this._primeConfigOptions();
        this._validateTurnOptions(options);
        const { sessionId, configOptions } = await this._acquireSession();
        await configureCursorSession(client, sessionId, { configOptions }, options);
        const prompt = responsesBodyToCursorPrompt(options.body);
        const promptResult = await client.request("session/prompt", { sessionId, prompt });
        eventProcessor.flush();
        return {
          text: textChunks.join(""),
          promptResult,
          initializeResult: null,
          events: eventProcessor.snapshot(),
          usage: usageFromAcpUsage(promptResult?.usage),
          stopReason: promptResult?.stopReason || "completed",
        };
      } catch (error) {
        if (client.closed || String(error?.message || "").includes("Cursor ACP exited")) {
          this.client = null;
          this.configOptions = null;
          this.idleSessions = [];
        }
        throw error;
      } finally {
        if (signal) signal.removeEventListener("abort", abort);
        client.options.eventProcessor = priorHandlers.eventProcessor;
        client.options.onEvent = priorHandlers.onEvent;
        client.options.onDelta = priorHandlers.onDelta;
        client.options.onStderr = priorHandlers.onStderr;
        client.options.onProtocolError = priorHandlers.onProtocolError;
      }
    });
  }

  async fetchModels(options) {
    return this.enqueue(async () => {
      const client = await this.ensureConnected();
      await this._primeConfigOptions();
      const pooled = this.idleSessions[0];
      const sessionId = pooled?.sessionId;
      if (typeof sessionId === "string" && sessionId) {
        try {
          const available = await client.request(CURSOR_LIST_AVAILABLE_MODELS_METHOD, { sessionId });
          const models = cursorModelsFromAvailableModels(available?.models);
          if (models.length > 0) return models;
        } catch (error) {
          options.onProtocolError?.(error);
        }
      }
      return cursorModelsFromConfigOptions(this.configOptions || []);
    });
  }

  async close() {
    return this.enqueue(async () => {
      this.idleSessions = [];
      this.configOptions = null;
      if (this.client) this.client.close();
      this.client = null;
    });
  }
}

function getCursorAcpRuntime(options) {
  const key = cursorAcpRuntimeKey(options);
  let runtime = cursorAcpRuntimes.get(key);
  if (!runtime) {
    runtime = new CursorAcpRuntime(options);
    cursorAcpRuntimes.set(key, runtime);
  }
  return runtime;
}

export async function shutdownCursorAcpRuntimes() {
  const runtimes = [...cursorAcpRuntimes.values()];
  cursorAcpRuntimes.clear();
  await Promise.all(runtimes.map((runtime) => runtime.close()));
}

export { cursorAcpPoolEnabled, getCursorAcpRuntime };
