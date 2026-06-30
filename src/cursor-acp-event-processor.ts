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
import { asRecord } from "./lib/record";
import type { AcpProcessorEvent, CursorAcpEventProcessor } from "./types/acp";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function trimNonEmpty(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

function normalizeToolKind(kind: unknown): string | undefined {
  return typeof kind === "string" && kind.trim() ? kind.trim() : undefined;
}

type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

function normalizeToolStatus(value: unknown, fallback = "in_progress"): ToolStatus {
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
      return fallback as ToolStatus;
  }
}

function summarizeLocations(locations: unknown): string {
  if (!Array.isArray(locations)) return "";
  const paths = locations
    .map((location) => {
      const record = asRecord(location);
      if (!record || typeof record.path !== "string" || !record.path.trim()) return "";
      return record.line === undefined || record.line === null
        ? record.path.trim()
        : `${record.path.trim()}:${record.line}`;
    })
    .filter(Boolean);
  if (paths.length === 0) return "";
  return paths.length === 1 ? paths[0] : `${paths[0]} +${paths.length - 1} more`;
}

function summarizeRawOutput(rawOutput: unknown): string {
  if (!isRecord(rawOutput)) return "";
  if (Number.isFinite(Number(rawOutput.totalFiles))) return `${Number(rawOutput.totalFiles)} files found`;
  if (typeof rawOutput.content === "string") {
    const lines = rawOutput.content.split(/\r?\n/u).filter(Boolean).length;
    return lines > 0 ? `Read ${lines} lines` : "";
  }
  if (Number.isFinite(Number(rawOutput.exitCode))) return `exit ${Number(rawOutput.exitCode)}`;
  return "";
}

function extractTextContentFromToolCallContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const chunks: string[] = [];
  for (const entry of content) {
    const entryRecord = asRecord(entry);
    if (entryRecord?.type !== "content") continue;
    const nested = asRecord(entryRecord.content);
    if (nested?.type !== "text" || typeof nested.text !== "string") continue;
    const text = nested.text.trim();
    if (text) chunks.push(text);
  }
  return chunks.length > 0 ? chunks.join("\n") : undefined;
}

function inferToolKindFromTitle(title: unknown): string {
  const normalized = String(title || "").trim().toLowerCase();
  if (normalized === "find") return "search";
  if (normalized === "read" || normalized === "read file") return "read";
  if (normalized === "terminal") return "execute";
  return "tool";
}

export interface CursorAcpToolCallState {
  id: string;
  kind: string;
  status: ToolStatus;
  title: string;
  command?: string;
  detail?: string;
  data: Record<string, unknown>;
}

export function mergeCursorAcpToolCallState(
  previous: CursorAcpToolCallState | undefined,
  next: CursorAcpToolCallState,
): CursorAcpToolCallState {
  if (!previous) return next;
  const nextData = asRecord(next.data);
  const nextKind = typeof nextData?.kind === "string" ? nextData.kind : next.kind;
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

export function shouldEmitToolCallUpdate(
  previous: CursorAcpToolCallState | undefined,
  next: CursorAcpToolCallState,
): boolean {
  if (next.status === "completed" || next.status === "failed") return true;
  if (!next.detail) return false;
  return !previous || previous.title !== next.title || previous.detail !== next.detail;
}

export function makeCursorAcpToolCallState(
  update: unknown,
  { fallbackStatus }: { fallbackStatus?: ToolStatus } = {},
): CursorAcpToolCallState | null {
  const record = asRecord(update);
  const toolCallId = trimNonEmpty(record?.toolCallId);
  if (!toolCallId) return null;

  const rawKind = normalizeToolKind(record?.kind);
  const kind = rawKind ?? inferToolKindFromTitle(record?.title);
  const status = normalizeToolStatus(
    record?.status,
    fallbackStatus ?? (record?.sessionUpdate === "tool_call" ? "pending" : "in_progress"),
  );
  const textContent = extractTextContentFromToolCallContent(record?.content);
  const locationDetail = summarizeLocations(record?.locations);
  const outputDetail = summarizeRawOutput(record?.rawOutput);

  const data: Record<string, unknown> = {
    toolCallId,
    kind,
    ...(record?.rawInput !== undefined ? { rawInput: record.rawInput } : {}),
    ...(record?.rawOutput !== undefined ? { rawOutput: record.rawOutput } : {}),
    ...(record?.content !== undefined ? { content: record.content } : {}),
    ...(record?.locations !== undefined ? { locations: record.locations } : {}),
  };

  const command = extractToolCommand(data, trimNonEmpty(record?.title));
  if (command) data.command = command;

  const fallbackDetail = command ?? locationDetail ?? outputDetail ?? textContent ?? trimNonEmpty(record?.title);
  const presentation = deriveToolActivityPresentation({
    itemType: canonicalItemTypeFromAcpToolKind(kind),
    title: trimNonEmpty(record?.title),
    detail: fallbackDetail,
    data,
    fallbackSummary: trimNonEmpty(record?.title) ?? "Tool",
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

export interface CursorAcpEventProcessorOptions {
  copilotToolNames?: Set<string>;
}

export function createCursorAcpEventProcessor(
  options: CursorAcpEventProcessorOptions = {},
): CursorAcpEventProcessor {
  const copilotToolNames = options.copilotToolNames instanceof Set ? options.copilotToolNames : new Set<string>();
  const toolCallsById = new Map<string, CursorAcpToolCallState>();
  let assistantSegmentOpen = false;
  let lastPlanFingerprint = "";

  const events: AcpProcessorEvent[] = [];

  const closeAssistantSegment = () => {
    if (!assistantSegmentOpen) return;
    assistantSegmentOpen = false;
    events.push({ type: "assistant_segment_completed" });
  };

  const openAssistantSegment = () => {
    if (!assistantSegmentOpen) assistantSegmentOpen = true;
  };

  const emitPlanUpdated = (payload: Record<string, unknown>) => {
    closeAssistantSegment();
    const fingerprint = JSON.stringify(payload);
    if (fingerprint === lastPlanFingerprint) return;
    lastPlanFingerprint = fingerprint;
    events.push({ type: "plan_updated", payload });
  };

  const emitQuestionAsked = (payload: Record<string, unknown>) => {
    closeAssistantSegment();
    events.push({ type: "question_asked", payload });
    if (copilotToolNames.has("ask_user")) {
      const questions = Array.isArray(payload.questions) ? payload.questions : [];
      const askUserArgs = askUserArgumentsFromQuestions(questions as Parameters<typeof askUserArgumentsFromQuestions>[0]);
      if (askUserArgs) {
        events.push({
          type: "copilot_tool_call",
          name: "ask_user",
          arguments: askUserArgs,
        });
      }
    }
  };

  const ingestSessionUpdate = (update: unknown) => {
    const record = asRecord(update);
    if (!record || typeof record.sessionUpdate !== "string") return;

    if (record.sessionUpdate === "plan") {
      const steps = planStepsFromSessionUpdate(record);
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

    if (record.sessionUpdate === "agent_message_chunk" || record.sessionUpdate === "agent_thought_chunk") {
      const content = asRecord(record.content);
      if (content?.type !== "text" || typeof content.text !== "string" || !content.text) return;
      if (record.sessionUpdate === "agent_message_chunk") openAssistantSegment();
      events.push({
        type: "content_delta",
        streamKind: record.sessionUpdate === "agent_thought_chunk" ? "reasoning_text" : "assistant_text",
        ...(trimNonEmpty(record.messageId) ? { itemId: trimNonEmpty(record.messageId) } : {}),
        text: content.text,
      });
      return;
    }

    if (record.sessionUpdate === "tool_call" || record.sessionUpdate === "tool_call_update") {
      closeAssistantSegment();
      const next = makeCursorAcpToolCallState(record, {
        fallbackStatus: record.sessionUpdate === "tool_call" ? "pending" : "in_progress",
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

  const ingestExtensionRequest = (method: string, params: unknown) => {
    const record = asRecord(params);
    if (method === "cursor/create_plan") {
      const steps = Array.isArray(record?.todos)
        ? extractTodosAsPlan(record).steps
        : [];
      emitPlanUpdated({
        title: trimNonEmpty(record?.name) ?? "Plan proposed",
        kind: "plan",
        source: method,
        toolCallId: trimNonEmpty(record?.toolCallId),
        planMarkdown: extractPlanMarkdown(record),
        steps,
        detail: trimNonEmpty(record?.overview) ?? summarizePlanSteps(steps),
        input: params,
      });
      return { accepted: true };
    }

    if (method === "cursor/update_todos") {
      const { steps } = extractTodosAsPlan(record);
      if (steps.length === 0) return { ok: true };
      emitPlanUpdated({
        title: "Todos updated",
        kind: "plan",
        source: method,
        toolCallId: trimNonEmpty(record?.toolCallId),
        steps,
        detail: summarizePlanSteps(steps),
        input: params,
      });
      return { ok: true };
    }

    if (method === "cursor/ask_question") {
      const questions = extractAskQuestions(record);
      const answers = autoAnswersForQuestions(questions);
      emitQuestionAsked({
        title: trimNonEmpty(record?.title) ?? "Cursor question",
        kind: "question",
        source: method,
        toolCallId: trimNonEmpty(record?.toolCallId),
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

  const ingestMessage = (message: unknown) => {
    const record = asRecord(message);
    if (record?.method !== "session/update") return;
    const params = asRecord(record.params);
    ingestSessionUpdate(params?.update);
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
