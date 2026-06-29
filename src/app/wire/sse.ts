import type { ServerResponse } from "node:http";

export function formatResponsesSseEvent(event: string, data: Record<string, unknown>, dataOnly: boolean) {
  const payload = JSON.stringify({ type: event, ...data });
  if (dataOnly) return `data: ${payload}\n\n`;
  return `event: ${event}\ndata: ${payload}\n\n`;
}

export function sseWrite(
  res: ServerResponse,
  event: string,
  data: Record<string, unknown>,
  dataOnly: boolean,
) {
  const payload = formatResponsesSseEvent(event, data, dataOnly);
  const socket = res.socket;
  if (typeof socket?.cork === "function") socket.cork();
  res.write(payload);
  if (typeof socket?.uncork === "function") socket.uncork();
  return payload.length;
}

export function beginResponsesSseStream(res: ServerResponse, extraHeaders: Record<string, string> = {}) {
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
  for (const [key, value] of Object.entries(extraHeaders)) {
    if (value !== undefined && value !== null) res.setHeader(key, value);
  }
  if (typeof res.flushHeaders === "function") res.flushHeaders();
}

export function flushResponsesSseStream(res: ServerResponse) {
  const flushable = res as ServerResponse & { flush?: () => void };
  if (typeof flushable.flush === "function") flushable.flush();
}

export function createSseRecorder(res: ServerResponse, dataOnly: boolean) {
  let sequenceNumber = 0;
  let bytes = 0;
  const recordWrite = (event: string, data: Record<string, unknown>) => {
    bytes += sseWrite(res, event, { sequence_number: sequenceNumber, ...data }, dataOnly);
    sequenceNumber += 1;
  };
  return { recordWrite, getBytes: () => bytes };
}

export function emitResponseInProgress(
  recordWrite: (event: string, data: Record<string, unknown>) => void,
  responsePayload: Record<string, unknown>,
) {
  recordWrite("response.in_progress", { response: responsePayload });
}

export function sseDone(_res: ServerResponse) {
  // Stream termination is signaled by response.completed.
}

export function responseObject({
  id,
  model,
  status = "in_progress",
  output = [],
  usage = null,
  error = null,
}: {
  id: string;
  model: string;
  status?: string;
  output?: unknown[];
  usage?: unknown;
  error?: unknown;
}) {
  const response: Record<string, unknown> = {
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

export function normalizeResponseUsage(usage: Record<string, number> | null | undefined) {
  if (!usage) return null;
  return {
    input_tokens: usage.input + usage.cacheRead + usage.cacheWrite,
    output_tokens: usage.output,
    total_tokens: usage.totalTokens || usage.input + usage.cacheRead + usage.cacheWrite + usage.output,
    input_tokens_details: { cached_tokens: usage.cacheRead || 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
}
