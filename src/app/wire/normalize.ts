import type { IncomingMessage } from "node:http";

export function normalizeModelId(model: unknown, defaultModel: string) {
  let value = typeof model === "string" && model.trim() ? model.trim() : defaultModel;
  if (value.includes("#")) value = value.slice(value.lastIndexOf("#") + 1);
  if (value.includes("/")) value = value.slice(value.lastIndexOf("/") + 1);
  if (value === "codexsub") value = defaultModel;
  if (value.startsWith("codexsub:")) value = value.slice("codexsub:".length);
  return value || defaultModel;
}

export function requestWantsEventStream(req: IncomingMessage | null | undefined) {
  if (!req?.headers) return true;
  const accept = String(req.headers.accept || req.headers.Accept || "").trim();
  if (!accept) return true;
  if (/text\/event-stream/i.test(accept)) return true;
  if (/\*\/\*/.test(accept)) return true;
  if (/application\/json/i.test(accept)) return false;
  return true;
}

export function requestCopilotStainlessStreamHelper(req: IncomingMessage | null | undefined) {
  const helper = String(
    req?.headers?.["x-stainless-helper-method"] || req?.headers?.["X-Stainless-Helper-Method"] || "",
  )
    .trim()
    .toLowerCase();
  return helper === "stream";
}

export function requestUsesCopilotNativeStream(
  req: IncomingMessage | null | undefined,
  body: { stream?: boolean } | null | undefined,
) {
  if (body?.stream === true) return true;
  if (requestCopilotStainlessStreamHelper(req)) return true;
  if (requestWantsEventStream(req)) return true;
  return false;
}

export type NormalizeRequestBodyOptions = {
  stripTools?: boolean;
  req?: IncomingMessage | null;
  defaultModel: string;
  reasoningEffortForModel: (modelId: string) => string | null | undefined;
};

export function normalizeRequestBody(bodyText: string, options: NormalizeRequestBodyOptions) {
  const { stripTools = false, req = null, defaultModel, reasoningEffortForModel } = options;
  let body: Record<string, unknown>;
  if (!bodyText.trim()) {
    body = {
      model: defaultModel,
      store: false,
      stream: requestWantsEventStream(req),
      instructions: "You are a helpful coding assistant.",
      input: [],
    };
  } else {
    body = JSON.parse(bodyText) as Record<string, unknown>;
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Responses request body must be a JSON object");
  }

  body.model = normalizeModelId(body.model, defaultModel);
  if (body.store === undefined) body.store = false;
  if (body.stream === undefined) {
    body.stream = req ? requestUsesCopilotNativeStream(req, body) : true;
  } else {
    body.stream = body.stream === true;
  }
  const modelId = String(body.model);
  const effectiveReasoningEffort = reasoningEffortForModel(modelId);
  if (effectiveReasoningEffort) {
    const currentReasoning =
      body.reasoning && typeof body.reasoning === "object" && !Array.isArray(body.reasoning)
        ? (body.reasoning as Record<string, unknown>)
        : {};
    body.reasoning = { ...currentReasoning, effort: effectiveReasoningEffort };
  }

  const strippedParams: string[] = [];
  if (Object.prototype.hasOwnProperty.call(body, "max_output_tokens")) {
    delete body.max_output_tokens;
    strippedParams.push("max_output_tokens");
  }

  const toolsIn = Array.isArray(body.tools) ? body.tools.length : 0;
  let strippedTools = false;
  if (stripTools && toolsIn > 0) {
    delete body.tools;
    delete body.tool_choice;
    delete body.parallel_tool_calls;
    strippedTools = true;
  }
  const toolsOut = Array.isArray(body.tools) ? body.tools.length : 0;

  return {
    body: JSON.stringify(body),
    info: {
      model: body.model,
      stream: body.stream,
      inputType: Array.isArray(body.input) ? "array" : typeof body.input,
      toolsIn,
      toolsOut,
      strippedTools,
      strippedParams,
      reasoningEffort: effectiveReasoningEffort || null,
    },
  };
}
