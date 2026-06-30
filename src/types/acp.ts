import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface JsonRpcErrorPayload {
  code?: number;
  message?: string;
  data?: { message?: string; [key: string]: unknown };
}

export interface JsonRpcError extends Error {
  code?: number;
  data?: JsonRpcErrorPayload["data"];
}

export interface AcpProcessorEvent {
  type: string;
  [key: string]: unknown;
}

export interface CursorAcpEventProcessor {
  ingestMessage: (message: unknown) => void;
  ingestSessionUpdate: (update: unknown) => void;
  ingestExtensionRequest: (method: string, params: unknown) => unknown;
  flush: () => AcpProcessorEvent[];
  snapshot: () => AcpProcessorEvent[];
  deliveredCount?: number;
}

export interface CursorAcpClientOptions {
  command: string;
  workspace: string;
  env?: NodeJS.ProcessEnv;
  apiEndpoint?: string;
  timeoutMs?: number;
  eventProcessor?: CursorAcpEventProcessor;
  onEvent?: (event: AcpProcessorEvent, raw: unknown) => void;
  onDelta?: (delta: string, raw: unknown) => void;
  onStderr?: (chunk: string) => void;
  onProtocolError?: (error: Error) => void;
  onNotification?: (message: unknown) => void;
  copilotToolNames?: Set<string>;
  signal?: AbortSignal;
  body?: unknown;
  model?: string;
  modelOptions?: Record<string, unknown>;
  reasoningEffort?: string;
}

export interface CursorAcpPendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CursorAcpPooledSession {
  sessionId: string;
  configOptions: unknown[];
}

export interface CursorAcpRuntimeOptions {
  command: string;
  workspace: string;
  env?: NodeJS.ProcessEnv;
  apiEndpoint?: string;
  timeoutMs?: number;
}

export interface CursorAcpSessionSetup {
  sessionId?: string;
  configOptions?: unknown[];
}

export interface CursorAcpPromptResult {
  usage?: unknown;
  stopReason?: string;
}

export interface CursorAcpAvailableModelsResult {
  models?: unknown;
}

export interface CursorAcpConfigOptionResult {
  configOptions?: unknown[];
}
