export function textFromChatMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "type" in part && (part as { type?: string }).type === "text") {
        const text = (part as { text?: string }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function chatCompletionsBodyToResponsesBody(body: Record<string, unknown>) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let instructions = typeof body.instructions === "string" ? body.instructions : "";
  const input: Record<string, unknown>[] = [];

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    const role = typeof record.role === "string" ? record.role : "user";
    if (role === "system") {
      const text = textFromChatMessageContent(record.content).trim();
      if (text) instructions = instructions ? `${instructions}\n\n${text}` : text;
      continue;
    }
    if (role === "tool") {
      const callId = typeof record.tool_call_id === "string" ? record.tool_call_id : "";
      const output = textFromChatMessageContent(record.content);
      if (callId || output) input.push({ type: "function_call_output", call_id: callId, output });
      continue;
    }
    if (role === "assistant") {
      if (Array.isArray(record.tool_calls)) {
        for (const toolCall of record.tool_calls) {
          const tc = toolCall as Record<string, unknown>;
          const fn = tc.function && typeof tc.function === "object" ? (tc.function as Record<string, unknown>) : {};
          input.push({
            type: "function_call",
            call_id: typeof tc.id === "string" ? tc.id : undefined,
            name: typeof fn.name === "string" ? fn.name : "tool",
            arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
          });
        }
      }
      const text = textFromChatMessageContent(record.content).trim();
      if (text) input.push({ role: "assistant", content: [{ type: "output_text", text }] });
      continue;
    }
    const text = textFromChatMessageContent(record.content).trim();
    if (text) input.push({ role: "user", content: [{ type: "input_text", text }] });
  }

  const responsesBody: Record<string, unknown> = {
    model: body.model,
    input,
    stream: body.stream === true,
    store: body.store,
    tools: body.tools,
    tool_choice: body.tool_choice,
    parallel_tool_calls: body.parallel_tool_calls,
    reasoning: body.reasoning,
    text: body.text,
  };
  if (instructions.trim()) responsesBody.instructions = instructions.trim();
  return responsesBody;
}

export function chatMessageFromResponsesOutput(output: unknown[]) {
  const textParts: string[] = [];
  const toolCalls: Record<string, unknown>[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type === "message" && record.role === "assistant") {
      for (const part of Array.isArray(record.content) ? record.content : []) {
        const p = part as Record<string, unknown>;
        if (p?.type === "output_text" && typeof p.text === "string" && p.text.trim()) textParts.push(p.text.trim());
      }
      continue;
    }
    if (record.type === "function_call") {
      toolCalls.push({
        id: record.call_id,
        type: "function",
        function: {
          name: record.name,
          arguments: typeof record.arguments === "string" ? record.arguments : JSON.stringify(record.arguments ?? {}),
        },
      });
    }
  }
  const message: Record<string, unknown> = {
    role: "assistant",
    content: textParts.length > 0 ? textParts.join("\n\n") : null,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return message;
}

export function chatCompletionObject({
  id,
  model,
  message,
  usage,
  finishReason = "stop",
}: {
  id: string;
  model: string;
  message: Record<string, unknown>;
  usage?: unknown;
  finishReason?: string;
}) {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

export function formatChatCompletionSseChunk(payload: Record<string, unknown>) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
