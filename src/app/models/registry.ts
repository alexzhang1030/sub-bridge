export type ModelEntry = {
  id: string;
  displayName: string;
  contextWindow: number;
  maxTokens: number;
  reasoningEffort?: string;
  defaultReasoningEffort?: string;
  cursorContextWindow?: string;
  cursorContext?: string;
  contextOption?: string;
  defaultContextWindow?: string;
  cursorModel?: string;
  upstreamProviderId?: string;
  upstreamProviderName?: string;
  fastMode?: boolean;
  thinking?: boolean;
  supportsFastMode?: boolean;
  supportsThinking?: boolean;
  supportedReasoningEfforts?: Array<{ value: string; label: string; isDefault?: boolean }>;
  contextWindowOptions?: Array<{ value: string; label: string; isDefault?: boolean }>;
};

export const BUILTIN_MODELS: ModelEntry[] = [
  {
    id: "gpt-5.5",
    displayName: "SubBridge GPT-5.5",
    contextWindow: 272000,
    maxTokens: 128000,
  },
  {
    id: "gpt-5.4",
    displayName: "SubBridge GPT-5.4",
    contextWindow: 272000,
    maxTokens: 128000,
  },
  {
    id: "gpt-5.4-mini",
    displayName: "SubBridge GPT-5.4 mini",
    contextWindow: 272000,
    maxTokens: 128000,
  },
  {
    id: "gpt-5.3-codex-spark",
    displayName: "SubBridge GPT-5.3 Codex Spark",
    contextWindow: 128000,
    maxTokens: 128000,
  },
];

export function normalizeModelEntry(model: unknown): ModelEntry | null {
  if (!model || typeof model !== "object") return null;
  const source = model as Record<string, unknown>;
  const rawId = source.id || source.slug || source.value || source.modelId || source.name;
  const id = typeof rawId === "string" && rawId.trim() ? rawId.trim() : "";
  if (!id) return null;
  const entry: ModelEntry = {
    id,
    displayName:
      typeof source.displayName === "string" && source.displayName.trim()
        ? source.displayName.trim()
        : typeof source.name === "string" && source.name.trim()
          ? source.name.trim()
          : `SubBridge ${id}`,
    contextWindow: Number.isFinite(Number(source.contextWindow)) ? Number(source.contextWindow) : 128000,
    maxTokens: Number.isFinite(Number(source.maxTokens)) ? Number(source.maxTokens) : 128000,
  };
  for (const key of [
    "reasoningEffort",
    "defaultReasoningEffort",
    "cursorContextWindow",
    "cursorContext",
    "contextOption",
    "defaultContextWindow",
    "cursorModel",
    "upstreamProviderId",
    "upstreamProviderName",
  ] as const) {
    if (typeof source[key] === "string" && (source[key] as string).trim()) {
      entry[key] = (source[key] as string).trim();
    }
  }
  for (const key of ["fastMode", "thinking", "supportsFastMode"] as const) {
    if (typeof source[key] === "boolean") entry[key] = source[key];
  }
  const supportsThinking = source.supportsThinking ?? source.supportsThinkingToggle;
  if (typeof supportsThinking === "boolean") entry.supportsThinking = supportsThinking;
  if (Array.isArray(source.supportedReasoningEfforts)) {
    entry.supportedReasoningEfforts = source.supportedReasoningEfforts
      .map((item) => {
        if (typeof item === "string") return { value: item, label: item };
        if (!item || typeof item !== "object" || !(item as { value?: string }).value) return null;
        const effort = item as { value: string; label?: string; isDefault?: boolean };
        return {
          value: String(effort.value),
          label: String(effort.label || effort.value),
          ...(effort.isDefault === true ? { isDefault: true } : {}),
        };
      })
      .filter(Boolean) as ModelEntry["supportedReasoningEfforts"];
  }
  if (Array.isArray(source.contextWindowOptions)) {
    entry.contextWindowOptions = source.contextWindowOptions
      .map((item) => {
        if (typeof item === "string") return { value: item, label: item.toUpperCase() };
        if (!item || typeof item !== "object" || !(item as { value?: string }).value) return null;
        const option = item as { value: string; label?: string; isDefault?: boolean };
        return {
          value: String(option.value),
          label: String(option.label || option.value),
          ...(option.isDefault === true ? { isDefault: true } : {}),
        };
      })
      .filter(Boolean) as ModelEntry["contextWindowOptions"];
  }
  return entry;
}

export function normalizeModelList(models: unknown): ModelEntry[] {
  if (!Array.isArray(models)) return [];
  const seen = new Set<string>();
  const normalized: ModelEntry[] = [];
  for (const model of models) {
    const entry = normalizeModelEntry(model);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    normalized.push(entry);
  }
  return normalized;
}
