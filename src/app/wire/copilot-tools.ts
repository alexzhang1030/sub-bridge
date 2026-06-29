import { randomUUID } from "node:crypto";
import { mergeCursorAcpToolCallState } from "./cursor-tool-state";
import { normalizeToolCallIds } from "./tool-ids";

export function safeToolIdentifier(value: unknown, fallback = "tool") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

const CURSOR_COPILOT_TOOL_KINDS = new Set([
  "execute",
  "search",
  "read",
  "edit",
  "delete",
  "move",
  "fetch",
  "tool",
  "plan",
  "question",
]);

export function cursorToolKind(toolCall: { kind?: string } | null | undefined) {
  const kind = safeToolIdentifier(toolCall?.kind || "tool", "tool");
  return CURSOR_COPILOT_TOOL_KINDS.has(kind) ? kind : "tool";
}

export function cursorToolName(toolCall: { kind?: string } | null | undefined) {
  return `subbridge_cursor_${cursorToolKind(toolCall)}`;
}

export function cursorToolArguments(toolCall: Record<string, unknown>) {
  return JSON.stringify({
    title: toolCall.title || cursorToolName(toolCall),
    status: toolCall.status || "in_progress",
    kind: toolCall.kind || "tool",
    ...(toolCall.detail ? { detail: toolCall.detail } : {}),
    ...(toolCall.command ? { command: toolCall.command } : {}),
    ...(toolCall.data &&
    typeof toolCall.data === "object" &&
    (toolCall.data as { rawInput?: unknown }).rawInput !== undefined
      ? { input: (toolCall.data as { rawInput?: unknown }).rawInput }
      : {}),
    ...(toolCall.data &&
    typeof toolCall.data === "object" &&
    (toolCall.data as { rawOutput?: unknown }).rawOutput !== undefined
      ? { output: (toolCall.data as { rawOutput?: unknown }).rawOutput }
      : {}),
    ...(toolCall.data &&
    typeof toolCall.data === "object" &&
    (toolCall.data as { locations?: unknown }).locations !== undefined
      ? { locations: (toolCall.data as { locations?: unknown }).locations }
      : {}),
  });
}

export function cursorToolStatusIsTerminal(status: string | undefined) {
  return status === "completed" || status === "failed";
}

export function cursorToolCallToFunctionCallItem(toolCall: Record<string, unknown>) {
  const ids = normalizeToolCallIds({ id: String(toolCall?.id || "") });
  return {
    id: ids.itemId,
    type: "function_call",
    call_id: ids.callId,
    name: cursorToolName(toolCall),
    arguments: cursorToolArguments(toolCall),
    status: cursorToolStatusIsTerminal(String(toolCall?.status)) ? "completed" : "in_progress",
  };
}

export function cursorExtensionPayloadToFunctionCallItem(payload: Record<string, unknown>) {
  const kind = safeToolIdentifier(payload?.kind || "tool", "tool");
  const normalizedKind = CURSOR_COPILOT_TOOL_KINDS.has(kind) ? kind : "tool";
  const ids = normalizeToolCallIds({ id: String(payload?.toolCallId || "") });
  return {
    id: ids.itemId,
    type: "function_call",
    call_id: ids.callId,
    name: `subbridge_cursor_${normalizedKind}`,
    arguments: JSON.stringify({
      title: payload?.title || `subbridge_cursor_${normalizedKind}`,
      status: "completed",
      kind: normalizedKind,
      ...(payload?.detail ? { detail: payload.detail } : {}),
      ...(payload?.steps ? { steps: payload.steps } : {}),
      ...(payload?.planMarkdown ? { planMarkdown: payload.planMarkdown } : {}),
      ...(payload?.questions ? { questions: payload.questions } : {}),
      ...(payload?.answers ? { answers: payload.answers } : {}),
      ...(payload?.source ? { source: payload.source } : {}),
    }),
    status: "completed",
  };
}

export function copilotNativeToolCallToFunctionCallItem(event: {
  name: string;
  arguments?: unknown;
}) {
  const ids = normalizeToolCallIds({});
  return {
    id: ids.itemId,
    type: "function_call",
    call_id: ids.callId,
    name: event.name,
    arguments: JSON.stringify(event.arguments && typeof event.arguments === "object" ? event.arguments : {}),
    status: "completed",
  };
}

export function summarizeCopilotToolParameters(parameters: Record<string, unknown> | null | undefined) {
  if (!parameters || typeof parameters !== "object") return "";
  const required = Array.isArray(parameters.required) ? parameters.required : [];
  const properties =
    parameters.properties && typeof parameters.properties === "object"
      ? (parameters.properties as Record<string, { type?: string }>)
      : {};
  const chunks = required.map((key) => {
    const schema = properties[key];
    const type = typeof schema?.type === "string" ? schema.type : "value";
    return `${key}:${type}`;
  });
  return chunks.length > 0 ? ` (requires ${chunks.join(", ")})` : "";
}

export function normalizeCopilotFunctionCallArguments(name: string, args: Record<string, unknown>) {
  const next = args && typeof args === "object" && !Array.isArray(args) ? { ...args } : {};
  if (name === "rename_session") {
    if (typeof next.title !== "string" && typeof next.name === "string") {
      next.title = next.name;
      delete next.name;
    }
  }
  return next;
}

export function normalizeCopilotFunctionCallItem(item: Record<string, unknown> | null | undefined) {
  if (!item || item.type !== "function_call" || typeof item.name !== "string") return item;
  if (item.name.startsWith("subbridge_cursor_")) return item;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(typeof item.arguments === "string" ? item.arguments : "{}") as Record<string, unknown>;
  } catch {
    args = {};
  }
  const normalized = normalizeCopilotFunctionCallArguments(item.name, args);
  return {
    ...item,
    arguments: JSON.stringify(normalized),
  };
}

export function pushFunctionCallItem(output: Record<string, unknown>[], item: Record<string, unknown>) {
  const normalized = normalizeCopilotFunctionCallItem(item) as Record<string, unknown>;
  const callId = typeof normalized.call_id === "string" ? normalized.call_id : "";
  if (callId && output.some((entry) => entry?.type === "function_call" && entry.call_id === callId)) return;
  output.push(normalized);
}

export function outputHasFunctionCalls(output: unknown) {
  return Array.isArray(output) && output.some((item) => (item as { type?: string })?.type === "function_call");
}

export function stripCompanionAssistantMessagesWhenFunctionCalls(output: Record<string, unknown>[]) {
  if (!outputHasFunctionCalls(output)) return;
  for (let index = output.length - 1; index >= 0; index -= 1) {
    const item = output[index];
    if (item?.type === "message" && item.role === "assistant") output.splice(index, 1);
  }
}

const COPILOT_TOOL_CALL_MARKER = /^COPILOT_FUNCTION_CALL:\s*(\{.*\})\s*$/gmu;

export function allowedCopilotToolNames(tools: unknown[]) {
  const names = new Set<string>();
  for (const tool of Array.isArray(tools) ? tools : []) {
    const source =
      (tool as { function?: { name?: string }; name?: string })?.function &&
      typeof (tool as { function?: { name?: string } }).function === "object"
        ? (tool as { function: { name?: string } }).function
        : (tool as { name?: string });
    const name = typeof source?.name === "string" ? source.name.trim() : "";
    if (name && !name.startsWith("subbridge_cursor_")) names.add(name);
  }
  return names;
}

export function extractCopilotToolCallsFromText(text: string, allowedNames: Set<string>) {
  const calls: Record<string, unknown>[] = [];
  if (!text || allowedNames.size === 0) return { calls, text: text || "" };
  let cleaned = String(text);
  for (const match of cleaned.matchAll(COPILOT_TOOL_CALL_MARKER)) {
    const raw = match[1];
    let parsed: { name?: string; arguments?: unknown };
    try {
      parsed = JSON.parse(raw) as { name?: string; arguments?: unknown };
    } catch {
      continue;
    }
    const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";
    if (!name || !allowedNames.has(name)) continue;
    const ids = normalizeToolCallIds({});
    const normalizedArgs = normalizeCopilotFunctionCallArguments(
      name,
      parsed?.arguments && typeof parsed.arguments === "object"
        ? (parsed.arguments as Record<string, unknown>)
        : {},
    );
    calls.push({
      id: ids.itemId,
      type: "function_call",
      call_id: ids.callId,
      name,
      arguments: JSON.stringify(normalizedArgs),
      status: "completed",
    });
    cleaned = cleaned.replace(match[0], "").trim();
  }
  return { calls, text: cleaned };
}

export type CursorJsonOutputLogger = (message: string, fields?: Record<string, unknown>) => void;

export function appendCursorJsonOutputFromEvents(
  output: Record<string, unknown>[],
  events: unknown[],
  fallbackText: string,
  {
    copilotTools = [],
    log = () => {},
  }: { copilotTools?: unknown[]; log?: CursorJsonOutputLogger } = {},
) {
  let reasoningText = "";
  let assistantSegment = "";
  const allowedNames = allowedCopilotToolNames(copilotTools);
  const cursorToolsById = new Map<string, Record<string, unknown>>();

  const pushReasoning = () => {
    const trimmed = reasoningText.trim();
    if (!trimmed) return;
    output.push({
      id: `rs_${randomUUID().replace(/-/g, "")}`,
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: trimmed }],
    });
    reasoningText = "";
  };

  const pushAssistantSegment = (text: string) => {
    const trimmed = String(text || "").trim();
    if (!trimmed) return;
    const extracted = extractCopilotToolCallsFromText(trimmed, allowedNames);
    for (const call of extracted.calls) pushFunctionCallItem(output, call);
    if (extracted.text) {
      output.push({
        id: `msg_${randomUUID().replace(/-/g, "")}`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: extracted.text, annotations: [] }],
      });
    }
  };

  for (const event of Array.isArray(events) ? events : []) {
    const entry = event as Record<string, unknown>;
    if (entry.type === "content_delta" && entry.streamKind === "reasoning_text") {
      reasoningText += String(entry.text || "");
      continue;
    }
    if (entry.type === "assistant_segment_completed") {
      pushReasoning();
      pushAssistantSegment(assistantSegment);
      assistantSegment = "";
      continue;
    }
    if (entry.type === "content_delta" && entry.streamKind === "assistant_text") {
      assistantSegment += String(entry.text || "");
      continue;
    }
    if (entry.type === "tool_call") {
      pushReasoning();
      pushAssistantSegment(assistantSegment);
      assistantSegment = "";
      const toolCall = entry.toolCall as Record<string, unknown> | undefined;
      const toolCallId = toolCall?.id as string | undefined;
      const merged = mergeCursorAcpToolCallState(
        toolCallId ? cursorToolsById.get(toolCallId) : undefined,
        toolCall,
      ) as Record<string, unknown>;
      if (toolCallId) cursorToolsById.set(toolCallId, merged);
      log("cursor.tool_call", JSON.parse(cursorToolArguments(merged)) as Record<string, unknown>);
      if (cursorToolStatusIsTerminal(String(merged?.status))) {
        pushFunctionCallItem(output, cursorToolCallToFunctionCallItem(merged));
        if (toolCallId) cursorToolsById.delete(toolCallId);
      }
      continue;
    }
    if (entry.type === "plan_updated" || entry.type === "question_asked") {
      pushReasoning();
      pushAssistantSegment(assistantSegment);
      assistantSegment = "";
      log(`cursor.${entry.type}`, entry.payload as Record<string, unknown>);
      pushFunctionCallItem(
        output,
        cursorExtensionPayloadToFunctionCallItem(entry.payload as Record<string, unknown>),
      );
      continue;
    }
    if (entry.type === "copilot_tool_call") {
      pushReasoning();
      pushAssistantSegment(assistantSegment);
      assistantSegment = "";
      log("cursor.copilot_tool_call", {
        name: entry.name,
        arguments: entry.arguments,
      });
      pushFunctionCallItem(
        output,
        copilotNativeToolCallToFunctionCallItem({
          name: String(entry.name),
          arguments: entry.arguments,
        }),
      );
    }
  }

  for (const toolCall of cursorToolsById.values()) {
    pushFunctionCallItem(output, cursorToolCallToFunctionCallItem({ ...toolCall, status: "completed" }));
  }

  pushReasoning();
  if (assistantSegment.trim()) {
    pushAssistantSegment(assistantSegment);
  } else if (
    fallbackText &&
    !(Array.isArray(events) ? events : []).some(
      (event) =>
        (event as { type?: string; streamKind?: string }).type === "content_delta" &&
        (event as { streamKind?: string }).streamKind === "assistant_text",
    )
  ) {
    pushAssistantSegment(fallbackText);
  }
  stripCompanionAssistantMessagesWhenFunctionCalls(output);
}

export function resolveCursorAcpModel(
  requestModel: string,
  options: {
    cursorModelSetting: string;
    modelConfigFor: (modelId: string) => { cursorModel?: string } | null | undefined;
  },
) {
  const modelConfig = options.modelConfigFor(requestModel);
  const configured = String(modelConfig?.cursorModel || options.cursorModelSetting || "request").trim();
  if (!configured || configured === "request") return requestModel;
  if (configured === "auto" || configured === "default") return "default";
  return configured;
}
