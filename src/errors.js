function messageFromUnknown(error) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    if (typeof error.message === "string") return error.message;
    if (typeof error.errorMessage === "string") return error.errorMessage;
  }
  return String(error || "");
}

export function errorMessage(error) {
  return messageFromUnknown(error);
}

export function isAbortLikeError(error) {
  const message = messageFromUnknown(error).toLowerCase();
  if (error && typeof error === "object") {
    if (error.name === "AbortError") return true;
    if (error.code === "ABORT_ERR") return true;
    if (isAbortLikeError(error.cause)) return true;
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

export function isRetryableTransientError(error) {
  if (isAbortLikeError(error)) return false;
  const message = messageFromUnknown(error).toLowerCase();
  if (error && typeof error === "object" && isRetryableTransientError(error.cause)) return true;
  return (
    message.includes("fetch failed") ||
    message.includes("socket hang up") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("und_err_socket")
  );
}
