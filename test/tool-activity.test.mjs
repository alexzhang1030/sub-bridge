import assert from "node:assert/strict";
import { test } from "vitest";

import { deriveToolActivityPresentation } from "../src/tool-activity.ts";
import {
  createCursorAcpEventProcessor,
  makeCursorAcpToolCallState,
  shouldEmitToolCallUpdate,
} from "../src/cursor-acp-event-processor.ts";

test("deriveToolActivityPresentation normalizes command tools", () => {
  assert.deepEqual(
    deriveToolActivityPresentation({
      itemType: "command_execution",
      title: "Terminal",
      detail: "Terminal",
      data: { command: "bun run lint" },
      fallbackSummary: "Terminal",
    }),
    {
      summary: "Ran command",
      detail: "bun run lint",
    },
  );
});

test("deriveToolActivityPresentation uses file paths for read tools", () => {
  assert.deepEqual(
    deriveToolActivityPresentation({
      itemType: "dynamic_tool_call",
      title: "Read File",
      detail: "Read File",
      data: {
        kind: "read",
        locations: [{ path: "/tmp/app.ts" }],
      },
      fallbackSummary: "Read File",
    }),
    {
      summary: "Read file",
      detail: "/tmp/app.ts",
    },
  );
});

test("cursor ACP event processor dedupes in-progress tool spam", () => {
  const processor = createCursorAcpEventProcessor();
  processor.ingestSessionUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "tool-1",
    title: "Terminal",
    kind: "execute",
    status: "pending",
    rawInput: { executable: "echo", args: ["pong"] },
  });
  processor.ingestSessionUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "tool-1",
    kind: "execute",
    status: "in_progress",
    rawInput: { executable: "echo", args: ["pong"] },
  });
  processor.ingestSessionUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "tool-1",
    kind: "execute",
    status: "completed",
    rawOutput: { exitCode: 0 },
    rawInput: { executable: "echo", args: ["pong"] },
  });
  const events = processor.flush();
  const toolEvents = events.filter((event) => event.type === "tool_call");
  assert.equal(toolEvents.length, 2);
  assert.equal(toolEvents[0].toolCall.title, "Ran command");
  assert.equal(toolEvents[0].toolCall.detail, "echo pong");
  assert.equal(toolEvents[1].toolCall.status, "completed");
});

test("cursor ACP event processor closes assistant segments before tools", () => {
  const processor = createCursorAcpEventProcessor();
  processor.ingestSessionUpdate({
    sessionUpdate: "agent_message_chunk",
    messageId: "answer-1",
    content: { type: "text", text: "before " },
  });
  processor.ingestSessionUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "tool-1",
    title: "Terminal",
    kind: "execute",
    status: "completed",
    rawInput: { command: "echo hi" },
  });
  processor.ingestSessionUpdate({
    sessionUpdate: "agent_message_chunk",
    messageId: "answer-2",
    content: { type: "text", text: "after" },
  });
  const events = processor.flush();
  assert.deepEqual(
    events.map((event) => event.type),
    ["content_delta", "assistant_segment_completed", "tool_call", "content_delta", "assistant_segment_completed"],
  );
});

test("shouldEmitToolCallUpdate requires detail for in-progress updates", () => {
  const base = makeCursorAcpToolCallState({
    sessionUpdate: "tool_call",
    toolCallId: "tool-1",
    title: "Terminal",
    kind: "execute",
    status: "pending",
    rawInput: { command: "echo hi" },
  });
  assert.equal(shouldEmitToolCallUpdate(undefined, base), true);
  assert.equal(
    shouldEmitToolCallUpdate(base, { ...base, status: "in_progress" }),
    false,
  );
});

test("cursor ACP event processor emits plan updates from session/update", () => {
  const processor = createCursorAcpEventProcessor();
  processor.ingestSessionUpdate({
    sessionUpdate: "plan",
    entries: [
      { content: "Inspect repo", status: "completed" },
      { content: "Apply fix", status: "in_progress" },
    ],
  });
  const events = processor.flush();
  assert.deepEqual(events.map((event) => event.type), ["plan_updated"]);
  assert.equal(events[0].payload.kind, "plan");
  assert.equal(events[0].payload.steps.length, 2);
  assert.match(events[0].payload.detail, /Inspect repo/);
});

test("cursor ACP event processor handles extension todos and dedupes plans", () => {
  const processor = createCursorAcpEventProcessor();
  processor.ingestExtensionRequest("cursor/update_todos", {
    todos: [{ content: "Write tests", status: "pending" }],
  });
  processor.ingestExtensionRequest("cursor/update_todos", {
    todos: [{ content: "Write tests", status: "pending" }],
  });
  const events = processor.flush();
  assert.deepEqual(events.map((event) => event.type), ["plan_updated"]);
  assert.equal(events[0].payload.title, "Todos updated");
});

test("cursor ACP event processor maps ask_question to ask_user when available", () => {
  const processor = createCursorAcpEventProcessor({ copilotToolNames: new Set(["ask_user"]) });
  processor.ingestExtensionRequest("cursor/ask_question", {
    title: "Pick one",
    questions: [
      {
        id: "mode",
        prompt: "Which mode?",
        options: [{ id: "fast", label: "Fast" }, { id: "safe", label: "Safe" }],
      },
    ],
  });
  const events = processor.flush();
  assert.deepEqual(events.map((event) => event.type), ["question_asked", "copilot_tool_call"]);
  assert.equal(events[0].payload.kind, "question");
  assert.equal(events[1].name, "ask_user");
  assert.equal(events[1].arguments.question, "Which mode?");
  assert.deepEqual(events[1].arguments.choices, ["Fast", "Safe"]);
});
