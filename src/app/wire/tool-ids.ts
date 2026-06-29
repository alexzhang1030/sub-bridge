import { randomUUID } from "node:crypto";

export function normalizeToolCallIds(item: { id?: string; call_id?: string }) {
  let rawItemId = String(item.id || "");
  let callId = String(item.call_id || "");
  if (rawItemId.includes("|")) {
    const parts = rawItemId.split("|");
    if (!callId) callId = parts[0];
    rawItemId = parts[1] || "";
  }
  if (!callId) callId = rawItemId || `call_${randomUUID().replace(/-/g, "")}`;
  let itemId = rawItemId || `fc_${randomUUID().replace(/-/g, "")}`;
  if (!itemId.startsWith("fc_")) itemId = `fc_${itemId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  return { callId, itemId, combinedId: `${callId}|${itemId}` };
}
