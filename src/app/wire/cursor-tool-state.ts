export function mergeCursorAcpToolCallState(
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
) {
  if (!previous) return next;
  if (!next) return previous;
  const nextData =
    next.data && typeof next.data === "object" ? (next.data as Record<string, unknown>) : {};
  const previousData =
    previous.data && typeof previous.data === "object" ? (previous.data as Record<string, unknown>) : {};
  const nextKind = typeof nextData.kind === "string" ? nextData.kind : next.kind;
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
      ...previousData,
      ...nextData,
      ...(kind ? { kind } : {}),
    },
  };
}
