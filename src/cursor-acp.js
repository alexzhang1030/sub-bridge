import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  collectCursorAcpConfigUpdates,
  cursorModelsFromAvailableModels,
  cursorModelsFromConfigOptions,
  CURSOR_LIST_AVAILABLE_MODELS_METHOD,
  mergeCursorModelOptions,
  modelConfigId,
  resolveCursorAcpModelValue,
} from "./cursor-models.js";

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

export function responsesBodyToCursorPrompt(body) {
  const textParts = [];
  const imageParts = [];

  if (typeof body.instructions === "string" && body.instructions.trim()) {
    textParts.push(`Instructions:\n${body.instructions.trim()}`);
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

function parseSessionTextDelta(message) {
  if (message?.method !== "session/update") return "";
  const update = message.params?.update;
  if (update?.sessionUpdate !== "agent_message_chunk") return "";
  const content = update.content;
  return content?.type === "text" && typeof content.text === "string" ? content.text : "";
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

class CursorAcpClient {
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
      const delta = parseSessionTextDelta(message);
      if (delta) this.options.onDelta?.(delta, message);
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
    if (message.method === "cursor/create_plan") {
      this.respond(message.id, { accepted: true });
      return;
    }
    if (message.method === "cursor/ask_question") {
      const answers = {};
      for (const question of Array.isArray(params.questions) ? params.questions : []) {
        const option = Array.isArray(question.options) ? question.options[0] : undefined;
        if (question.id) answers[question.id] = option?.id || option?.label || "";
      }
      this.respond(message.id, { answers });
      return;
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

  close() {
    this.closed = true;
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
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

async function configureCursorSession(client, sessionId, sessionSetup, options) {
  let configOptions = Array.isArray(sessionSetup?.configOptions) ? sessionSetup.configOptions : [];
  const requestedModel = options.model && options.model !== "default" ? options.model : "auto";
  const modelOptions = mergeCursorModelOptions(
    options.modelOptions,
    options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : null,
  );
  const modelValue = resolveCursorAcpModelValue(configOptions, requestedModel, modelOptions);
  if (modelValue) {
    const result = await setConfigOption(client, sessionId, modelConfigId(configOptions), modelValue);
    if (Array.isArray(result?.configOptions)) configOptions = result.configOptions;
  }

  for (const update of collectCursorAcpConfigUpdates(configOptions, modelOptions)) {
    const result = await setConfigOption(client, sessionId, update.configId, update.value);
    if (Array.isArray(result?.configOptions)) configOptions = result.configOptions;
  }
}

export async function runCursorAcpTurn(options) {
  const textChunks = [];
  const client = new CursorAcpClient({
    ...options,
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
      clientInfo: { name: "sub-bridge", version: "0.1.0" },
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
    const outputText = textChunks.join("");
    return {
      text: outputText,
      promptResult,
      initializeResult,
      usage: usageFromAcpUsage(promptResult?.usage),
      stopReason: promptResult?.stopReason || "completed",
    };
  } finally {
    if (signal) signal.removeEventListener("abort", abort);
    client.close();
  }

}

export async function fetchCursorAcpModels(options) {
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
      clientInfo: { name: "sub-bridge", version: "0.1.0" },
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

export function makeCursorEnv({ baseEnv = process.env, forceCi = true } = {}) {
  return {
    ...baseEnv,
    ...(forceCi ? { CI: "1" } : {}),
  };
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
