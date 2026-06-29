// @ts-nocheck
import {
  canonicalItemTypeFromAcpToolKind,
  deriveToolActivityPresentation,
  extractToolCommand,
} from "./tool-activity";
import {
  autoAnswersForQuestions,
  askUserArgumentsFromQuestions,
  extractAskQuestions,
  extractPlanMarkdown,
  extractTodosAsPlan,
  planStepsFromSessionUpdate,
  summarizePlanSteps,
  summarizeQuestions,
} from "./cursor-acp-extension";

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function trimNonEmpty(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

function normalizeToolKind(kind) {
  return typeof kind === "string" && kind.trim() ? kind.trim() : undefined;
}

function normalizeToolStatus(value, fallback = "in_progress") {
  switch (value) {
    case "pending":
      return "pending";
    case "in_progress":
    case "inProgress":
      return "in_progress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return fallback;
  }
}

function summarizeLocations(locations) {
  if (!Array.isArray(locations)) return "";
  const paths = locations
    .map((location) => {
      if (!location || typeof location.path !== "string" || !location.path.trim()) return "";
      return location.line === undefined || location.line === null
        ? location.path.trim()
        : `${location.path.trim()}:${location.line}`;
    })
    .filter(Boolean);
  if (paths.length === 0) return "";
  return paths.length === 1 ? paths[0] : `${paths[0]} +${paths.length - 1} more`;
}

function summarizeRawOutput(rawOutput) {
  if (!isRecord(rawOutput)) return "";
  if (Number.isFinite(Number(rawOutput.totalFiles))) return `${Number(rawOutput.totalFiles)} files found`;
  if (typeof rawOutput.content === "string") {
    const lines = rawOutput.content.split(/\r?\n/u).filter(Boolean).length;
    return lines > 0 ? `Read ${lines} lines` : "";
  }
  if (Number.isFinite(Number(rawOutput.exitCode))) return `exit ${Number(rawOutput.exitCode)}`;
  return "";
}

function extractTextContentFromToolCallContent(content) {
  if (!Array.isArray(content)) return undefined;
  const chunks = [];
  for (const entry of content) {
    if (entry?.type !== "content") continue;
    const nested = entry.content;
    if (nested?.type !== "text" || typeof nested.text !== "string") continue;
    const text = nested.text.trim();
    if (text) chunks.push(text);
  }
  return chunks.length > 0 ? chunks.join("\n") : undefined;
}

function inferToolKindFromTitle(title) {
  const normalized = String(title || "").trim().toLowerCase();
  if (normalized === "find") return "search";
  if (normalized === "read" || normalized === "read file") return "read";
  if (normalized === "terminal") return "execute";
  return "tool";
}

export function mergeCursorAcpToolCallState(previous, next) {
  if (!previous) return next;
  const nextKind = typeof next.data?.kind === "string" ? next.data.kind : next.kind;
  const kind = nextKind || previous.kind;
  return {
    ...previous,
    ...next,
    kind,
    status: next.status || previous.status,
    title: next.title || previous.title,
    command: next.command || previous.command,
    detail: next.detail || previous.detail,
    data: {
      ...(previous.data || {}),
      ...(next.data || {}),
      ...(kind ? { kind } : {}),
    },
  };
}

export function shouldEmitToolCallUpdate(previous, next) {
  if (next.status === "completed" || next.status === "failed") return true;
  if (!next.detail) return false;
  return !previous || previous.title !== next.title || previous.detail !== next.detail;
}

export function makeCursorAcpToolCallState(update, { fallbackStatus } = {}) {
  const toolCallId = trimNonEmpty(update.toolCallId);
  if (!toolCallId) return null;

  const rawKind = normalizeToolKind(update.kind);
  const kind = rawKind ?? inferToolKindFromTitle(update.title);
  const status = normalizeToolStatus(
    update.status,
    fallbackStatus ?? (update.sessionUpdate === "tool_call" ? "pending" : "in_progress"),
  );
  const textContent = extractTextContentFromToolCallContent(update.content);
  const locationDetail = summarizeLocations(update.locations);
  const outputDetail = summarizeRawOutput(update.rawOutput);

  const data = {
    toolCallId,
    kind,
    ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
    ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
    ...(update.content !== undefined ? { content: update.content } : {}),
    ...(update.locations !== undefined ? { locations: update.locations } : {}),
  };

  const command = extractToolCommand(data, update.title);
  if (command) data.command = command;

  const fallbackDetail = command ?? locationDetail ?? outputDetail ?? textContent ?? trimNonEmpty(update.title);
  const presentation = deriveToolActivityPresentation({
    itemType: canonicalItemTypeFromAcpToolKind(kind),
    title: update.title,
    detail: fallbackDetail,
    data,
    fallbackSummary: trimNonEmpty(update.title) ?? "Tool",
  });

  return {
    id: toolCallId,
    kind,
    status,
    title: presentation.summary,
    ...(command ? { command } : {}),
    ...(presentation.detail ? { detail: presentation.detail } : {}),
    data,
  };
}

export function createCursorAcpEventProcessor(options = {}) {
  const copilotToolNames = options.copilotToolNames instanceof Set ? options.copilotToolNames : new Set();
  const toolCallsById = new Map();
  let assistantSegmentOpen = false;
  let lastPlanFingerprint = "";

  const events = [];

  const closeAssistantSegment = () => {
    if (!assistantSegmentOpen) return;
    assistantSegmentOpen = false;
    events.push({ type: "assistant_segment_completed" });
  };

  const openAssistantSegment = () => {
    if (!assistantSegmentOpen) assistantSegmentOpen = true;
  };

  const emitPlanUpdated = (payload) => {
    closeAssistantSegment();
    const fingerprint = JSON.stringify(payload);
    if (fingerprint === lastPlanFingerprint) return;
    lastPlanFingerprint = fingerprint;
    events.push({ type: "plan_updated", payload });
  };

  const emitQuestionAsked = (payload) => {
    closeAssistantSegment();
    events.push({ type: "question_asked", payload });
    if (copilotToolNames.has("ask_user")) {
      const askUserArgs = askUserArgumentsFromQuestions(payload.questions);
      if (askUserArgs) {
        events.push({
          type: "copilot_tool_call",
          name: "ask_user",
          arguments: askUserArgs,
        });
      }
    }
  };

  const ingestSessionUpdate = (update) => {
    if (!update || typeof update.sessionUpdate !== "string") return;

    if (update.sessionUpdate === "plan") {
      const steps = planStepsFromSessionUpdate(update);
      if (steps.length === 0) return;
      emitPlanUpdated({
        title: "Plan updated",
        kind: "plan",
        source: "acp.plan",
        steps,
        detail: summarizePlanSteps(steps),
      });
      return;
    }

    if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
      const content = update.content;
      if (content?.type !== "text" || typeof content.text !== "string" || !content.text) return;
      if (update.sessionUpdate === "agent_message_chunk") openAssistantSegment();
      events.push({
        type: "content_delta",
        streamKind: update.sessionUpdate === "agent_thought_chunk" ? "reasoning_text" : "assistant_text",
        ...(trimNonEmpty(update.messageId) ? { itemId: trimNonEmpty(update.messageId) } : {}),
        text: content.text,
      });
      return;
    }

    if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      closeAssistantSegment();
      const next = makeCursorAcpToolCallState(update, {
        fallbackStatus: update.sessionUpdate === "tool_call" ? "pending" : "in_progress",
      });
      if (!next) return;

      const previous = toolCallsById.get(next.id);
      const merged = mergeCursorAcpToolCallState(previous, next);
      if (!shouldEmitToolCallUpdate(previous, merged)) return;

      if (merged.status === "completed" || merged.status === "failed") {
        toolCallsById.delete(next.id);
      } else {
        toolCallsById.set(next.id, merged);
      }

      events.push({ type: "tool_call", toolCall: merged });
    }
  };

  const ingestExtensionRequest = (method, params) => {
    if (method === "cursor/create_plan") {
      const steps = Array.isArray(params?.todos)
        ? extractTodosAsPlan(params).steps
        : [];
      emitPlanUpdated({
        title: trimNonEmpty(params?.name) ?? "Plan proposed",
        kind: "plan",
        source: method,
        toolCallId: trimNonEmpty(params?.toolCallId),
        planMarkdown: extractPlanMarkdown(params),
        steps,
        detail: trimNonEmpty(params?.overview) ?? summarizePlanSteps(steps),
        input: params,
      });
      return { accepted: true };
    }

    if (method === "cursor/update_todos") {
      const { steps } = extractTodosAsPlan(params);
      if (steps.length === 0) return { ok: true };
      emitPlanUpdated({
        title: "Todos updated",
        kind: "plan",
        source: method,
        toolCallId: trimNonEmpty(params?.toolCallId),
        steps,
        detail: summarizePlanSteps(steps),
        input: params,
      });
      return { ok: true };
    }

    if (method === "cursor/ask_question") {
      const questions = extractAskQuestions(params);
      const answers = autoAnswersForQuestions(questions);
      emitQuestionAsked({
        title: trimNonEmpty(params?.title) ?? "Cursor question",
        kind: "question",
        source: method,
        toolCallId: trimNonEmpty(params?.toolCallId),
        questions,
        answers,
        detail: summarizeQuestions(questions, answers),
        input: params,
        output: { answers },
      });
      return { answers };
    }

    return undefined;
  };

  const ingestMessage = (message) => {
    if (message?.method !== "session/update") return;
    ingestSessionUpdate(message.params?.update);
  };

  const flush = () => {
    closeAssistantSegment();
    return events;
  };

  const snapshot = () => events.slice();

  return {
    ingestMessage,
    ingestSessionUpdate,
    ingestExtensionRequest,
    flush,
    snapshot,
  };
}
