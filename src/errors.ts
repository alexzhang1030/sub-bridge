function messageFromUnknown(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    if (typeof record.errorMessage === "string") return record.errorMessage;
  }
  return String(error || "");
}

export function errorMessage(error: unknown): string {
  return messageFromUnknown(error);
}

export function isAbortLikeError(error: unknown): boolean {
  const message = messageFromUnknown(error).toLowerCase();
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown> & { cause?: unknown };
    if (record.name === "AbortError") return true;
    if (record.code === "ABORT_ERR") return true;
    if (isAbortLikeError(record.cause)) return true;
  }
  return (
    message.includes("request was aborted") ||
    message.includes("operation was aborted") ||
    message.includes("this operation was aborted") ||
    message.includes("[canceled]") ||
    message.includes("[cancelled]") ||
    message.includes("error code cancel") ||
    message.includes("stream closed with error code cancel")
  );
}

export function isRetryableTransientError(error: unknown): boolean {
  if (isAbortLikeError(error)) return false;
  const message = messageFromUnknown(error).toLowerCase();
  if (error && typeof error === "object" && isRetryableTransientError((error as { cause?: unknown }).cause)) {
    return true;
  }
  return (
    message.includes("fetch failed") ||
    message.includes("socket hang up") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("und_err_socket")
  );
}
