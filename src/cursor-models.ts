import type { ModelGroupsConfig } from "./types/config";
import type {
  CursorConfigOption,
  CursorContextWindowOption,
  CursorModelChoice,
  CursorModelEntry,
  CursorModelGroupEntry,
  CursorModelGroupSummary,
  CursorModelOptions,
  CursorReasoningEffort,
  CursorSelectOptionEntry,
} from "./types/cursor";

export const CURSOR_LIST_AVAILABLE_MODELS_METHOD = "cursor/list_available_models";

function normalizedText(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function stripCursorParameterizedSuffix(value: unknown): string {
  const trimmed = String(value || "").trim();
  const suffixStart = trimmed.indexOf("[");
  return suffixStart >= 0 ? trimmed.slice(0, suffixStart).trim() : trimmed;
}

function parseCursorModelParameters(value: unknown): Map<string, string> {
  const match = String(value || "").match(/\[([^\]]*)\]$/u);
  if (!match?.[1]) return new Map();
  const params = new Map<string, string>();
  for (const part of match[1].split(",")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = part.slice(0, separatorIndex).trim();
    const paramValue = part.slice(separatorIndex + 1).trim();
    if (key && paramValue) params.set(key, paramValue);
  }
  return params;
}

function cursorModelParametersToObject(value: unknown): Record<string, string> {
  return Object.fromEntries(parseCursorModelParameters(value).entries());
}

function buildCursorParameterizedModelSlug(baseModel: string, params: Record<string, string>): string {
  const entries = Object.entries(params).filter(([, paramValue]) => String(paramValue || "").trim());
  if (entries.length === 0) return baseModel;
  return `${baseModel}[${entries.map(([key, value]) => `${key}=${value}`).join(",")}]`;
}

function flattenSelectOptions(option: CursorConfigOption | undefined): Array<{
  value: string;
  name: string;
  groupId?: string;
  groupName?: string;
}> {
  if (!option || option.type !== "select" || !Array.isArray(option.options)) return [];
  return option.options.flatMap((entry: CursorSelectOptionEntry) => {
    if (typeof entry?.value === "string") {
      return [{ value: entry.value.trim(), name: String(entry.name || entry.value).trim() }];
    }
    if (Array.isArray(entry?.options)) {
      return entry.options.flatMap((child: CursorSelectOptionEntry) =>
        typeof child?.value === "string"
          ? [{
              value: child.value.trim(),
              name: String(child.name || child.value).trim(),
              groupId: typeof entry.group === "string" ? entry.group.trim() : undefined,
              groupName: typeof entry.name === "string" ? entry.name.trim() : undefined,
            }]
          : [],
      );
    }
    return [];
  });
}

function findModelConfig(configOptions: CursorConfigOption[]): CursorConfigOption | undefined {
  return (
    configOptions.find((option) => option?.category === "model" && typeof option.id === "string") ||
    configOptions.find((option) => option?.id === "model")
  );
}

function findConfigOption(configOptions: CursorConfigOption[], aliases: string[]): CursorConfigOption | undefined {
  const normalizedAliases = aliases.map(normalizedText);
  return configOptions.find((option) => {
    const haystack = normalizedText(`${option?.id || ""} ${option?.name || ""} ${option?.category || ""}`);
    return normalizedAliases.some((alias) => haystack.includes(alias));
  });
}

function humanizeCursorModelName(value: unknown): string {
  const base = stripCursorParameterizedSuffix(value);
  if (!base) return String(value || "");
  return base
    .split(/[-_/]+/u)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "gpt") return "GPT";
      if (lower === "ai") return "AI";
      if (lower === "codex") return "Codex";
      if (lower === "claude") return "Claude";
      if (lower === "opus") return "Opus";
      if (lower === "sonnet") return "Sonnet";
      if (lower === "haiku") return "Haiku";
      if (lower === "gemini") return "Gemini";
      if (lower === "grok") return "Grok";
      if (lower === "kimi") return "Kimi";
      if (lower === "llama") return "Llama";
      if (lower === "qwen") return "Qwen";
      return `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
}

function normalizeCursorAcpModelName(choice: { value: string; name?: string }): string {
  const rawName = String(choice.name || "").trim();
  const rawBase = stripCursorParameterizedSuffix(choice.value);
  if (
    rawName &&
    rawName.toLowerCase() !== choice.value.trim().toLowerCase() &&
    rawName.toLowerCase() !== rawBase.toLowerCase()
  ) {
    return rawName;
  }
  return humanizeCursorModelName(choice.value);
}

function inferCursorUpstreamProvider(choice: {
  value?: string;
  name?: string;
  groupId?: string;
  groupName?: string;
}): { upstreamProviderId: string; upstreamProviderName: string } {
  const groupId = String(choice.groupId || "").trim();
  const groupName = String(choice.groupName || "").trim();
  if (groupId || groupName) {
    return {
      upstreamProviderId: (groupId || groupName || "cursor").toLowerCase().replace(/\s+/gu, "-"),
      upstreamProviderName: groupName || groupId || "Cursor",
    };
  }

  const token = stripCursorParameterizedSuffix(`${choice.value} ${choice.name}`).trim().toLowerCase();
  if (token.includes("claude")) return { upstreamProviderId: "anthropic", upstreamProviderName: "Anthropic" };
  if (token.includes("gemini")) return { upstreamProviderId: "google", upstreamProviderName: "Google" };
  if (token.includes("grok")) return { upstreamProviderId: "xai", upstreamProviderName: "xAI" };
  if (token.includes("kimi")) return { upstreamProviderId: "moonshot", upstreamProviderName: "Moonshot AI" };
  if (token.includes("deepseek")) return { upstreamProviderId: "deepseek", upstreamProviderName: "DeepSeek" };
  if (token.includes("qwen")) return { upstreamProviderId: "alibaba", upstreamProviderName: "Alibaba" };
  if (token.includes("llama")) return { upstreamProviderId: "meta", upstreamProviderName: "Meta" };
  if (token.includes("mistral")) return { upstreamProviderId: "mistral", upstreamProviderName: "Mistral" };
  if (
    token.includes("gpt") ||
    token.includes("codex") ||
    token.includes("o1") ||
    token.includes("o3") ||
    token.includes("o4")
  ) {
    return { upstreamProviderId: "openai", upstreamProviderName: "OpenAI" };
  }
  return { upstreamProviderId: "cursor", upstreamProviderName: "Cursor" };
}

function flattenCursorAcpModelChoices(configOptions: CursorConfigOption[]): CursorModelChoice[] {
  const seen = new Set<string>();
  const choices: CursorModelChoice[] = [];
  for (const choice of flattenSelectOptions(findModelConfig(configOptions))) {
    if (!choice.value || seen.has(choice.value)) continue;
    seen.add(choice.value);
    const upstreamProvider = inferCursorUpstreamProvider(choice);
    choices.push({
      slug: choice.value,
      name: normalizeCursorAcpModelName(choice),
      ...upstreamProvider,
    });
  }
  return choices;
}

export function normalizeCursorReasoningValue(value: unknown): string {
  const normalized = String(value || "").trim().toLowerCase();
  switch (normalized) {
    case "none":
    case "low":
    case "medium":
    case "high":
    case "max":
      return normalized;
    case "xhigh":
    case "extra-high":
    case "extra high":
      return "xhigh";
    default:
      return "";
  }
}

function cursorReasoningParameterValue(value: string): string {
  return value === "xhigh" ? "extra-high" : value;
}

function cursorReasoningLabel(value: string): string {
  if (value === "xhigh") return "Extra High";
  if (value === "max") return "Max";
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function findCursorEffortConfigOption(configOptions: CursorConfigOption[]): CursorConfigOption | undefined {
  const candidates = configOptions.filter((option) => {
    if (option?.type !== "select") return false;
    const id = String(option.id || "").trim().toLowerCase();
    const name = String(option.name || "").trim().toLowerCase();
    return (
      id === "effort" ||
      id === "reasoning" ||
      name === "effort" ||
      name === "reasoning" ||
      name.includes("effort") ||
      name.includes("reasoning") ||
      option.category === "thought_level"
    );
  });
  return (
    candidates.find((option) => option.category === "model_option") ||
    candidates.find((option) => String(option.id || "").trim().toLowerCase() === "effort") ||
    candidates.find((option) => option.category === "thought_level") ||
    candidates[0]
  );
}

function isCursorContextConfigOption(option: CursorConfigOption | undefined): boolean {
  const id = String(option?.id || "").trim().toLowerCase();
  const name = String(option?.name || "").trim().toLowerCase();
  return id === "context" || id === "context_size" || name.includes("context");
}

function findCursorContextConfigOption(configOptions: CursorConfigOption[]): CursorConfigOption | undefined {
  return configOptions.find((option) => option?.category === "model_config" && isCursorContextConfigOption(option)) ||
    configOptions.find(isCursorContextConfigOption);
}

function findCursorBooleanOption(configOptions: CursorConfigOption[], id: string): CursorConfigOption | undefined {
  return configOptions.find((option) => String(option?.id || "").trim().toLowerCase() === id);
}

function contextWindowTokens(value: unknown, fallback = 128000): number {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return fallback;
  const match = raw.match(/^(\d+(?:\.\d+)?)(k|m)?$/u);
  if (!match) return fallback;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return fallback;
  const suffix = match[2] || "";
  if (suffix === "m") return Math.round(amount * 1_000_000);
  if (suffix === "k") return Math.round(amount * 1_000);
  return Math.round(amount);
}

function cursorContextWindowLabel(value: unknown): string {
  const normalized = String(value || "").trim();
  return normalized.toLowerCase() === "1m" ? "1M" : normalized.toUpperCase();
}

function buildModelEntry(input: {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxTokens?: number;
  upstreamProviderId?: string;
  upstreamProviderName?: string;
  supportedReasoningEfforts?: CursorReasoningEffort[];
  defaultReasoningEffort?: string;
  supportsFastMode?: boolean;
  supportsThinking?: boolean;
  contextWindowOptions?: CursorContextWindowOption[];
  defaultContextWindow?: string;
}): CursorModelEntry {
  const id = input.id === "default" ? "auto" : input.id;
  const entry: CursorModelEntry = {
    id,
    displayName: input.displayName || humanizeCursorModelName(id),
    contextWindow: input.contextWindow || 128000,
    maxTokens: input.maxTokens || 128000,
  };
  if (input.upstreamProviderId) entry.upstreamProviderId = input.upstreamProviderId;
  if (input.upstreamProviderName) entry.upstreamProviderName = input.upstreamProviderName;
  if (input.supportedReasoningEfforts?.length) entry.supportedReasoningEfforts = input.supportedReasoningEfforts;
  if (input.defaultReasoningEffort) entry.defaultReasoningEffort = input.defaultReasoningEffort;
  if (input.supportsFastMode) entry.supportsFastMode = true;
  if (input.supportsThinking) entry.supportsThinking = true;
  if (input.contextWindowOptions?.length) entry.contextWindowOptions = input.contextWindowOptions;
  if (input.defaultContextWindow) entry.defaultContextWindow = input.defaultContextWindow;
  return entry;
}

export function cursorModelsFromConfigOptions(configOptions: unknown): CursorModelEntry[] {
  const choices = flattenCursorAcpModelChoices(Array.isArray(configOptions) ? configOptions : []);
  return choices.map((choice) => buildModelEntry({
    id: choice.slug,
    displayName: choice.name,
    contextWindow: 128000,
    maxTokens: 128000,
    upstreamProviderId: choice.upstreamProviderId,
    upstreamProviderName: choice.upstreamProviderName,
  }));
}

export function cursorModelsFromAvailableModels(models: unknown): CursorModelEntry[] {
  const seen = new Set<string>();
  const entries: CursorModelEntry[] = [];
  for (const model of Array.isArray(models) ? models : []) {
    const modelRecord = model as Record<string, unknown>;
    const rawId = String(modelRecord?.value || modelRecord?.id || "").trim();
    if (!rawId) continue;
    const id = rawId === "default" ? "auto" : rawId;
    if (seen.has(id)) continue;
    seen.add(id);

    const configOptions = Array.isArray(model.configOptions) ? model.configOptions : [];
    const effortOption = findCursorEffortConfigOption(configOptions);
    const supportedReasoningEfforts = effortOption?.type === "select"
      ? flattenSelectOptions(effortOption).flatMap((entry) => {
          const value = normalizeCursorReasoningValue(entry.value);
          return value ? [{ value, label: cursorReasoningLabel(value) }] : [];
        })
      : [];
    const defaultReasoningEffort =
      effortOption?.type === "select" ? normalizeCursorReasoningValue(effortOption.currentValue) : "";

    const contextOption = findCursorContextConfigOption(configOptions);
    const contextWindowOptions = contextOption?.type === "select"
      ? flattenSelectOptions(contextOption).map((entry) => ({
          value: entry.value,
          label: cursorContextWindowLabel(entry.value),
          ...(contextOption.currentValue === entry.value ? { isDefault: true } : {}),
        }))
      : [];
    const defaultContextWindow =
      contextWindowOptions.find((option) => option.isDefault)?.value ||
      (contextWindowOptions.length === 1 ? contextWindowOptions[0].value : "");

    const upstreamProvider = inferCursorUpstreamProvider({
      value: id,
      name: String(model.name || model.displayName || id),
    });
    entries.push(buildModelEntry({
      id,
      displayName: String(model.name || model.displayName || humanizeCursorModelName(id)).trim(),
      contextWindow: contextWindowTokens(defaultContextWindow, 128000),
      maxTokens: 128000,
      upstreamProviderId: upstreamProvider.upstreamProviderId,
      upstreamProviderName: upstreamProvider.upstreamProviderName,
      supportedReasoningEfforts,
      defaultReasoningEffort,
      supportsFastMode: Boolean(findCursorBooleanOption(configOptions, "fast") || findConfigOption(configOptions, ["fast", "fast mode"])),
      supportsThinking: Boolean(findCursorBooleanOption(configOptions, "thinking") || findConfigOption(configOptions, ["thinking"])),
      contextWindowOptions,
      defaultContextWindow,
    }));
  }
  return entries;
}

export function parseCursorCliModelList(stdout: unknown): CursorModelEntry[] {
  const seen = new Set<string>();
  const models: CursorModelEntry[] = [];
  for (const line of String(stdout || "").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "Available models" || trimmed.startsWith("Tip:")) continue;
    const separatorIndex = trimmed.indexOf(" - ");
    const id = separatorIndex > 0 ? trimmed.slice(0, separatorIndex).trim() : trimmed.split(/\s{2,}|\t/u)[0].trim();
    const name = separatorIndex > 0 ? trimmed.slice(separatorIndex + 3).replace(/\s+\((?:default|current)\)$/iu, "").trim() : id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const options = cursorModelOptionsFromCliModelId(id);
    models.push({
      id,
      displayName: name || humanizeCursorModelName(id),
      contextWindow: contextWindowTokens(options.contextWindow, 128000),
      maxTokens: 128000,
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      ...(options.fastMode ? { fastMode: options.fastMode } : {}),
      ...(options.thinking ? { thinking: options.thinking } : {}),
    });
  }
  return models;
}

function normalizeCursorCliBaseModelId(model: unknown): string {
  const trimmed = String(model || "").trim();
  let withoutVariantSuffixes = trimmed
    .replace(/^claude-(\d+(?:\.\d+)?)-([a-z]+)-max$/u, "claude-$1-$2")
    .replace(/-preview$/u, "");
  for (let index = 0; index < 3; index += 1) {
    const next = withoutVariantSuffixes
      .replace(/-fast$/u, "")
      .replace(/-thinking$/u, "")
      .replace(/-(?:extra-high|none|low|medium|high|xhigh)$/u, "");
    withoutVariantSuffixes =
      next.endsWith("-max") && !next.includes("codex-max")
        ? next.slice(0, -"-max".length)
        : next;
  }

  const claudeReordered = withoutVariantSuffixes.match(/^claude-(\d+(?:\.\d+)?)-([a-z]+)$/u);
  if (claudeReordered) {
    const version = claudeReordered[1];
    const family = claudeReordered[2];
    if (version && family) return `claude-${family}-${version.replace(".", "-")}`;
  }
  return withoutVariantSuffixes;
}

export function normalizeCursorModelVariantBaseId(model: unknown): string {
  return normalizeCursorCliBaseModelId(stripCursorParameterizedSuffix(model));
}

function parseCursorCliReasoningEffort(model: unknown): string {
  const tokens = String(model || "").trim().toLowerCase().split("-");
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token === "xhigh") return "xhigh";
    if (token === "high" && tokens[index - 1] === "extra") return "xhigh";
    if (["max", "none", "low", "medium", "high"].includes(token)) return token;
  }
  return "";
}

function isCursorCliOneMillionContextModel(model: unknown): boolean {
  const normalized = String(model || "").trim().toLowerCase();
  return (
    normalized.startsWith("gpt-5.5-") ||
    /^gpt-5\.4-(?:low|medium|high|xhigh|extra-high)$/u.test(normalized) ||
    /^claude-4\.6-(?:opus|sonnet)(?:-|$)/u.test(normalized) ||
    /^claude-(?:fable-5|opus-4-(?:7|8))-/u.test(normalized)
  );
}

export function cursorModelOptionsFromCliModelId(model: unknown): CursorModelOptions {
  const trimmed = String(model || "").trim();
  if (!trimmed || trimmed.includes("[")) return {};
  const lower = trimmed.toLowerCase();
  const reasoningEffort = parseCursorCliReasoningEffort(lower);
  return {
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(lower.endsWith("-fast") ? { fastMode: true } : {}),
    ...(lower.includes("-thinking") ? { thinking: true } : {}),
    ...(isCursorCliOneMillionContextModel(lower) ? { contextWindow: "1m" } : {}),
  };
}

function uniqueByValue<T extends { value?: string }>(values: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    if (!value?.value || seen.has(value.value)) continue;
    seen.add(value.value);
    result.push(value);
  }
  return result;
}

function removeVariantNameSuffix(name: unknown): string {
  return String(name || "")
    .replace(/\s+Fast$/iu, "")
    .replace(/\s+Thinking$/iu, "")
    .replace(/\s+Fast$/iu, "")
    .replace(/\s+(?:None|Low|Medium|High|Extra High|Max)$/iu, "")
    .replace(/\s+1M$/u, "")
    .trim();
}

function defaultEffortForCursorGroup(baseId: string, efforts: string[]): string {
  if (efforts.length === 0) return "";
  if (baseId.includes("gpt") || baseId.includes("codex")) return efforts.includes("medium") ? "medium" : efforts[0];
  if (baseId.includes("claude")) return efforts.includes("high") ? "high" : efforts[0];
  return efforts[0];
}

function isCursorOneMillionVariant(model: CursorModelEntry): boolean {
  if (model.defaultContextWindow === "1m") return true;
  if (model.contextWindowOptions?.some((option: CursorContextWindowOption) => option.value === "1m" && option.isDefault === true)) return true;
  return /\b1M\b/u.test(model.displayName || "");
}

function fallbackContextWindowOptionsForCursorBase(baseId: string, variants: CursorModelEntry[]): CursorContextWindowOption[] {
  if (!variants.some(isCursorOneMillionVariant)) return [];
  if (baseId === "gpt-5.5" || baseId === "gpt-5.4") {
    return [
      { value: "272k", label: "272K", isDefault: true },
      { value: "1m", label: "1M" },
    ];
  }
  if (baseId === "claude-fable-5" || baseId === "claude-opus-4-8" || baseId === "claude-opus-4-7") {
    return [
      { value: "300k", label: "300K", isDefault: true },
      { value: "1m", label: "1M" },
    ];
  }
  if (baseId === "claude-opus-4-6" || baseId === "claude-sonnet-4-6") {
    return [
      { value: "200k", label: "200K", isDefault: true },
      { value: "1m", label: "1M" },
    ];
  }
  return [];
}

interface CursorVariantOptions {
  contextWindow?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  thinking?: boolean;
}

function cursorVariantDisplayName(baseName: string, { contextWindow, reasoningEffort, fastMode, thinking }: CursorVariantOptions): string {
  const parts = [removeVariantNameSuffix(baseName) || baseName];
  if (contextWindow) parts.push(cursorContextWindowLabel(contextWindow));
  if (reasoningEffort) parts.push(cursorReasoningLabel(reasoningEffort));
  if (thinking) parts.push("Thinking");
  if (fastMode) parts.push("Fast");
  return parts.filter(Boolean).join(" ");
}

function cursorVariantId(baseId: string, { contextWindow, reasoningEffort, fastMode, thinking }: CursorVariantOptions): string {
  const params: Record<string, string> = {};
  if (contextWindow) params.context = contextWindow;
  if (reasoningEffort) params.effort = cursorReasoningParameterValue(reasoningEffort);
  if (fastMode) params.fast = "true";
  if (thinking) params.thinking = "true";
  return buildCursorParameterizedModelSlug(baseId, params);
}

function cursorVariantOptionsForModel(model: CursorModelEntry): {
  efforts: string[];
  contexts: string[];
  fastModes: boolean[];
  thinkingModes: boolean[];
} {
  const effortValues = uniqueByValue([
    ...(model.supportedReasoningEfforts || []),
    ...(model.defaultReasoningEffort ? [{ value: model.defaultReasoningEffort, label: cursorReasoningLabel(model.defaultReasoningEffort) }] : []),
    ...(model.reasoningEffort ? [{ value: model.reasoningEffort, label: cursorReasoningLabel(model.reasoningEffort) }] : []),
  ])
    .map((entry) => normalizeCursorReasoningValue(entry.value))
    .filter(Boolean);
  const contextValues = uniqueByValue([
    ...(model.contextWindowOptions || []),
    ...(model.defaultContextWindow ? [{ value: model.defaultContextWindow, label: cursorContextWindowLabel(model.defaultContextWindow) }] : []),
    ...(model.cursorContextWindow ? [{ value: model.cursorContextWindow, label: cursorContextWindowLabel(model.cursorContextWindow) }] : []),
    ...(model.contextOption ? [{ value: model.contextOption, label: cursorContextWindowLabel(model.contextOption) }] : []),
  ])
    .map((entry) => String(entry.value || "").trim())
    .filter(Boolean);
  return {
    efforts: effortValues.length > 0 ? effortValues : [""],
    contexts: contextValues.length > 0 ? contextValues : [""],
    fastModes: model.supportsFastMode ? [false, true] : [false],
    thinkingModes: model.supportsThinking ? [false, true] : [false],
  };
}

function generatedCursorVariantsForModel(model: CursorModelEntry): CursorModelEntry[] {
  const baseId = normalizeCursorModelVariantBaseId(model.id);
  if (!baseId || model.id.includes("[") || normalizeCursorModelVariantBaseId(model.id) !== model.id) return [];
  const { efforts, contexts, fastModes, thinkingModes } = cursorVariantOptionsForModel(model);
  if (
    efforts.every((value) => !value) &&
    contexts.every((value) => !value) &&
    fastModes.length === 1 &&
    thinkingModes.length === 1
  ) {
    return [];
  }
  const variants: CursorModelEntry[] = [];
  for (const contextWindow of contexts) {
    for (const reasoningEffort of efforts) {
      for (const fastMode of fastModes) {
        for (const thinking of thinkingModes) {
          if (!contextWindow && !reasoningEffort && !fastMode && !thinking) continue;
          const id = cursorVariantId(baseId, { contextWindow, reasoningEffort, fastMode, thinking });
          if (id === model.id) continue;
          variants.push({
            ...model,
            id,
            displayName: cursorVariantDisplayName(model.displayName, {
              contextWindow,
              reasoningEffort,
              fastMode,
              thinking,
            }),
            contextWindow: contextWindowTokens(contextWindow, model.contextWindow),
            ...(contextWindow ? { cursorContextWindow: contextWindow } : {}),
            ...(reasoningEffort ? { reasoningEffort } : {}),
            ...(fastMode ? { fastMode: true } : {}),
            ...(thinking ? { thinking: true } : {}),
          });
        }
      }
    }
  }
  return variants;
}

export function collapseCursorModelVariants(models: unknown): CursorModelEntry[] {
  const groups = new Map<string, CursorModelEntry[]>();
  for (const model of Array.isArray(models) ? models : []) {
    const entry = model as CursorModelEntry;
    const baseId = normalizeCursorModelVariantBaseId(entry.id) || entry.id;
    const group = groups.get(baseId);
    if (group) group.push(entry);
    else groups.set(baseId, [entry]);
  }

  return Array.from(groups.entries()).map(([baseId, variants]) => {
    const preferred =
      variants.find((variant: CursorModelEntry) => variant.id === baseId) ||
      variants.find((variant: CursorModelEntry) => !variant.id.endsWith("-fast")) ||
      variants[0];
    const efforts = uniqueByValue(variants.flatMap((variant: CursorModelEntry) => [
      ...(variant.supportedReasoningEfforts || []),
      ...(parseCursorCliReasoningEffort(variant.id)
        ? [{ value: parseCursorCliReasoningEffort(variant.id), label: cursorReasoningLabel(parseCursorCliReasoningEffort(variant.id)) }]
        : []),
      ...(variant.defaultReasoningEffort
        ? [{ value: variant.defaultReasoningEffort, label: cursorReasoningLabel(variant.defaultReasoningEffort) }]
        : []),
    ]));
    const effortValues = efforts.map((effort) => effort.value);
    const defaultEffort =
      variants.find((variant: CursorModelEntry) => normalizeCursorModelVariantBaseId(variant.id) === variant.id)?.defaultReasoningEffort ||
      defaultEffortForCursorGroup(baseId, effortValues);
    const contextWindowOptions = uniqueByValue([
      ...fallbackContextWindowOptionsForCursorBase(baseId, variants),
      ...variants.flatMap((variant: CursorModelEntry) => variant.contextWindowOptions || []),
    ]);
    const upstreamProviderId = preferred?.upstreamProviderId;
    const upstreamProviderName = preferred?.upstreamProviderName;
    return buildModelEntry({
      id: baseId,
      displayName: removeVariantNameSuffix(preferred?.displayName || humanizeCursorModelName(baseId)),
      contextWindow: contextWindowTokens(
        contextWindowOptions.find((option) => option.isDefault)?.value || contextWindowOptions[0]?.value,
        preferred?.contextWindow || 128000,
      ),
      maxTokens: preferred?.maxTokens || 128000,
      upstreamProviderId,
      upstreamProviderName,
      supportedReasoningEfforts: efforts.map((effort) => ({
        value: effort.value,
        label: effort.label || cursorReasoningLabel(effort.value),
        ...(effort.value === defaultEffort ? { isDefault: true } : {}),
      })),
      defaultReasoningEffort: defaultEffort,
      supportsFastMode: variants.some((variant: CursorModelEntry) => variant.supportsFastMode === true),
      supportsThinking: variants.some((variant: CursorModelEntry) => variant.supportsThinking === true),
      contextWindowOptions,
      defaultContextWindow:
        contextWindowOptions.find((option) => option.isDefault)?.value ||
        contextWindowOptions[0]?.value ||
        preferred?.defaultContextWindow,
    });
  });
}

export function mergeCursorModelVariantsWithBaseControls(models: unknown): CursorModelEntry[] {
  const normalized = Array.isArray(models) ? (models as CursorModelEntry[]) : [];
  const expanded = normalized.flatMap((model) => [model, ...generatedCursorVariantsForModel(model)]);
  const seen = new Set<string>();
  const merged: CursorModelEntry[] = [];
  for (const model of [...collapseCursorModelVariants(expanded), ...expanded]) {
    const key = String(model?.id || "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(model);
  }
  return dedupeCursorModelsByVisibleName(merged);
}

function cursorVisibleModelKey(model: CursorModelEntry): string {
  const familyId = normalizeCursorModelVariantBaseId(model?.id) || String(model?.id || "").trim();
  const displayName = String(model?.displayName || humanizeCursorModelName(model?.id)).trim();
  return `${familyId}|${normalizedText(displayName)}`;
}

function cursorVisibleModelPriority(model: CursorModelEntry): number {
  const id = String(model?.id || "").trim();
  if (id.includes("[")) return 0;
  if (normalizeCursorModelVariantBaseId(id) === id) return 1;
  return 2;
}

function dedupeCursorModelsByVisibleName(models: CursorModelEntry[]): CursorModelEntry[] {
  const entries: CursorModelEntry[] = [];
  const byKey = new Map<string, number>();
  for (const model of models) {
    const key = cursorVisibleModelKey(model);
    const existingIndex = byKey.get(key);
    if (existingIndex === undefined) {
      byKey.set(key, entries.length);
      entries.push(model);
      continue;
    }
    const existing = entries[existingIndex];
    if (cursorVisibleModelPriority(model) < cursorVisibleModelPriority(existing)) {
      entries[existingIndex] = model;
    }
  }
  return entries;
}

const CURSOR_MODEL_PRESETS: Record<string, Array<{ id: string; displayName: string }>> = {
  latest: [
    { id: "claude-opus-4-8[context=1m,effort=high]", displayName: "Opus 4.8" },
    { id: "claude-opus-4-8[context=1m,effort=high,fast=true]", displayName: "Opus 4.8 Fast" },
    { id: "claude-opus-4-8[context=1m,effort=high,thinking=true]", displayName: "Opus 4.8 Thinking" },
    { id: "claude-opus-4-8[context=1m,effort=high,fast=true,thinking=true]", displayName: "Opus 4.8 Thinking Fast" },
    { id: "gpt-5.5[context=1m,effort=medium]", displayName: "GPT-5.5" },
    { id: "gpt-5.5[context=1m,effort=medium,fast=true]", displayName: "GPT-5.5 Fast" },
    { id: "composer-2.5", displayName: "Composer 2.5" },
    { id: "composer-2.5[fast=true]", displayName: "Composer 2.5 Fast" },
    { id: "glm-5.2", displayName: "GLM 5.2" },
  ],
};

function normalizeCursorModelPreset(value: unknown): keyof typeof CURSOR_MODEL_PRESETS | "" {
  const preset = String(value || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(CURSOR_MODEL_PRESETS, preset) ? (preset as keyof typeof CURSOR_MODEL_PRESETS) : "";
}

function applyCursorModelPreset(models: CursorModelEntry[], preset: keyof typeof CURSOR_MODEL_PRESETS | ""): CursorModelEntry[] {
  const rules = CURSOR_MODEL_PRESETS[preset] || [];
  if (rules.length === 0) return models;
  const byId = new Map((Array.isArray(models) ? models : []).map((model) => [String(model?.id || "").trim(), model]));
  return rules.flatMap((rule) => {
    const model = byId.get(rule.id);
    return model ? [{ ...model, displayName: rule.displayName }] : [];
  });
}

export function cursorModelGroupEntries(model: CursorModelEntry): CursorModelGroupEntry[] {
  const providerId = String(model?.upstreamProviderId || "cursor").trim().toLowerCase() || "cursor";
  const providerName = String(model?.upstreamProviderName || "Cursor").trim() || "Cursor";
  const familyId = normalizeCursorModelVariantBaseId(model?.id) || String(model?.id || "").trim();
  const familyName = removeVariantNameSuffix(model?.displayName || humanizeCursorModelName(familyId));
  return [
    { id: `provider:${providerId}`, type: "provider", name: providerName },
    { id: `family:${familyId}`, type: "family", name: familyName },
  ];
}

export function normalizeModelGroupsConfig(config: unknown): ModelGroupsConfig & { preset: keyof typeof CURSOR_MODEL_PRESETS | "" } {
  const record = config as ModelGroupsConfig | undefined;
  const disabled = Array.isArray(record?.disabled) ? record.disabled : [];
  const only = Array.isArray(record?.only) ? record.only : [];
  return {
    disabled: Array.from(new Set(disabled.map((value) => String(value || "").trim()).filter(Boolean))).sort(),
    only: Array.from(new Set(only.map((value) => String(value || "").trim()).filter(Boolean))),
    preset: normalizeCursorModelPreset(record?.preset),
  };
}

export function filterCursorModelsByGroups(models: unknown, config: unknown): CursorModelEntry[] {
  const groupsConfig = normalizeModelGroupsConfig(config);
  const disabled = new Set(groupsConfig.disabled);
  const only = new Set(groupsConfig.only);
  const normalized = Array.isArray(models) ? models : [];
  if (disabled.size === 0 && only.size === 0) return applyCursorModelPreset(normalized, groupsConfig.preset);
  const onlyOrder = new Map((groupsConfig.only ?? []).map((groupId, index) => [groupId, index]));
  const filtered = normalized.flatMap((model, index) => {
    const groupIds = cursorModelGroupEntries(model).map((group) => group.id);
    const selected = only.size === 0 || groupIds.some((groupId) => only.has(groupId));
    const enabled = groupIds.every((groupId) => !disabled.has(groupId));
    if (!selected || !enabled) return [];
    const groupOrder = groupIds.reduce((lowest, groupId) => {
      const order = onlyOrder.get(groupId);
      return order === undefined ? lowest : Math.min(lowest, order);
    }, Number.MAX_SAFE_INTEGER);
    return [{ model, index, groupOrder }];
  });
  const grouped = filtered
    .sort((left, right) => left.groupOrder - right.groupOrder || left.index - right.index)
    .map((entry) => entry.model);
  return applyCursorModelPreset(grouped, groupsConfig.preset);
}

export function summarizeCursorModelGroups(models: unknown, config: unknown): CursorModelGroupSummary[] {
  const groupsConfig = normalizeModelGroupsConfig(config);
  const disabled = new Set(groupsConfig.disabled);
  const only = new Set(groupsConfig.only);
  const filtered = new Set(filterCursorModelsByGroups(models, config).map((model) => String(model?.id || "").trim()));
  const byId = new Map<string, CursorModelGroupSummary>();
  for (const model of Array.isArray(models) ? models : []) {
    const active = filtered.has(String(model?.id || "").trim());
    for (const group of cursorModelGroupEntries(model)) {
      const selected = only.size === 0 || only.has(group.id);
      const current = byId.get(group.id) || {
        ...group,
        modelCount: 0,
        activeModelCount: 0,
        selected,
        enabled: selected && !disabled.has(group.id),
      };
      current.modelCount += 1;
      if (active) current.activeModelCount += 1;
      current.selected = selected;
      current.enabled = selected && !disabled.has(group.id);
      byId.set(group.id, current);
    }
  }
  return Array.from(byId.values()).sort((left, right) =>
    left.type.localeCompare(right.type) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
}

function cursorModelOptionsFromModelParameters(model: unknown): CursorModelOptions {
  const params = parseCursorModelParameters(model);
  const reasoningEffort = normalizeCursorReasoningValue(params.get("reasoning") || params.get("effort"));
  const contextWindow = String(params.get("context") || "").trim();
  const fastModeParam = String(params.get("fast") || "").trim().toLowerCase();
  const thinkingParam = String(params.get("thinking") || "").trim().toLowerCase();
  const fastMode = fastModeParam === "true" ? true : fastModeParam === "false" ? false : undefined;
  const thinking = thinkingParam === "true" ? true : thinkingParam === "false" ? false : undefined;
  return {
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
  };
}

export function cursorOptionsFromModelEntry(model: unknown): CursorModelOptions {
  if (!model || typeof model !== "object") return {};
  const entry = model as CursorModelEntry;
  const explicitContextWindow = entry.cursorContextWindow || entry.cursorContext || entry.contextOption;
  const defaultContextWindow = entry.defaultContextWindow;
  const rawReasoningEffort = entry.reasoningEffort || entry.defaultReasoningEffort;
  const normalizedReasoningEffort = String(rawReasoningEffort || "").trim().toLowerCase();
  const reasoningEffort =
    normalizedReasoningEffort && !["off", "false", "0", "disabled", "fast", "true", "1"].includes(normalizedReasoningEffort)
      ? String(rawReasoningEffort)
      : "";
  const fastModeFromReasoning =
    ["off", "false", "0", "disabled"].includes(normalizedReasoningEffort)
      ? false
      : ["fast", "true", "1"].includes(normalizedReasoningEffort)
        ? true
        : undefined;
  return {
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(explicitContextWindow || defaultContextWindow
      ? { contextWindow: String(explicitContextWindow || defaultContextWindow) }
      : {}),
    ...(typeof entry.fastMode === "boolean"
      ? { fastMode: entry.fastMode }
      : fastModeFromReasoning !== undefined
        ? { fastMode: fastModeFromReasoning }
        : {}),
    ...(typeof entry.thinking === "boolean" ? { thinking: entry.thinking } : {}),
  };
}

export function mergeCursorModelOptions(...sources: Array<CursorModelOptions | null | undefined>): CursorModelOptions | undefined {
  const merged: CursorModelOptions = {};
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    if (source.reasoningEffort) merged.reasoningEffort = source.reasoningEffort;
    if (source.contextWindow) merged.contextWindow = source.contextWindow;
    if (typeof source.fastMode === "boolean") merged.fastMode = source.fastMode;
    if (typeof source.thinking === "boolean") merged.thinking = source.thinking;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function resolveReasoningEffortForModel(modelConfig: unknown, fallbackReasoningEffort?: string): string | undefined {
  if (!modelConfig || typeof modelConfig !== "object") return undefined;
  const config = modelConfig as CursorModelEntry;
  if (typeof config.reasoningEffort === "string" && config.reasoningEffort.trim()) {
    return config.reasoningEffort.trim();
  }
  if (typeof config.defaultReasoningEffort === "string" && config.defaultReasoningEffort.trim()) {
    return config.defaultReasoningEffort.trim();
  }
  if (Array.isArray(config.supportedReasoningEfforts) && config.supportedReasoningEfforts.length > 0) {
    const defaultEntry = config.supportedReasoningEfforts.find((item) => item?.isDefault);
    if (defaultEntry?.value) return String(defaultEntry.value);
    return fallbackReasoningEffort;
  }
  return undefined;
}

function cursorAcpParameterKeyForModel(baseModel: string, options: CursorModelOptions | undefined): string {
  if (options?.reasoningEffort && String(baseModel || "").includes("claude")) return "effort";
  return "reasoning";
}

function cursorChoiceMatchesBase(choice: CursorModelChoice, baseModel: string): boolean {
  const choiceBase = resolveCursorAcpBaseModelId(choice.slug);
  const cliBaseModel = normalizeCursorCliBaseModelId(baseModel);
  return choiceBase === baseModel || choiceBase === cliBaseModel;
}

function cursorParameterValuesMatch(key: string, left: unknown, right: unknown): boolean {
  if (key === "reasoning" || key === "effort") {
    return normalizeCursorReasoningValue(left) === normalizeCursorReasoningValue(right);
  }
  return normalizedText(left) === normalizedText(right);
}

function resolveCursorChoiceParameterValue({
  choices,
  baseModel,
  key,
  requestedValue,
}: {
  choices: CursorModelChoice[];
  baseModel: string;
  key: string;
  requestedValue: unknown;
}): string | undefined {
  let sawParameterizedChoice = false;
  for (const choice of choices) {
    if (!cursorChoiceMatchesBase(choice, baseModel)) continue;
    const value = parseCursorModelParameters(choice.slug).get(key);
    if (!value) continue;
    sawParameterizedChoice = true;
    if (cursorParameterValuesMatch(key, value, requestedValue)) return value;
  }
  return sawParameterizedChoice ? undefined : String(requestedValue ?? "");
}

function buildCursorParameterizedModelFromOptions({
  acpModelValue,
  options,
  choices,
  requestedModel,
}: {
  acpModelValue: string;
  options: CursorModelOptions;
  choices: CursorModelChoice[];
  requestedModel: string;
}): string | undefined {
  const hasOptions = options && Object.keys(options).length > 0;
  const requestedHasParams = String(requestedModel || "").includes("[");
  if (!hasOptions && !requestedHasParams) return undefined;
  const baseModel = stripCursorParameterizedSuffix(acpModelValue || requestedModel);
  const requestedParams = cursorModelParametersToObject(requestedModel || "");
  const acpParams = cursorModelParametersToObject(acpModelValue);
  const params = { ...requestedParams, ...acpParams };
  const requestedParamKeys = new Set(Object.keys(requestedParams));
  const acpParamKeys = new Set(Object.keys(acpParams));
  const slugUsesParam = (key: string) => requestedParamKeys.has(key) || acpParamKeys.has(key);
  if (options.reasoningEffort && (slugUsesParam("reasoning") || slugUsesParam("effort"))) {
    const parameterKey = cursorAcpParameterKeyForModel(baseModel, options);
    params[parameterKey] =
      resolveCursorChoiceParameterValue({
        choices,
        baseModel,
        key: parameterKey,
        requestedValue: options.reasoningEffort,
      }) || cursorReasoningParameterValue(options.reasoningEffort);
  }
  if (options.contextWindow && slugUsesParam("context")) params.context = options.contextWindow;
  if (typeof options.fastMode === "boolean" && slugUsesParam("fast")) params.fast = String(options.fastMode);
  if (typeof options.thinking === "boolean" && slugUsesParam("thinking")) params.thinking = String(options.thinking);
  return buildCursorParameterizedModelSlug(baseModel, params);
}

export function resolveCursorAcpBaseModelId(model: unknown): string {
  const trimmed = String(model || "").trim();
  if (!trimmed || trimmed === "auto") return "auto";
  return stripCursorParameterizedSuffix(trimmed) || "auto";
}

function resolveCursorAutoModelValue(choices: CursorModelChoice[]): string | undefined {
  return (
    choices.find((choice) => choice.slug.trim().toLowerCase() === "auto")?.slug ||
    choices.find((choice) => choice.slug.trim().toLowerCase() === "default")?.slug ||
    choices.find((choice) => normalizedText(choice.name) === "auto")?.slug
  );
}

function cursorModelParametersEqualExceptFast(left: unknown, right: unknown): boolean {
  const leftParams = cursorModelParametersToObject(left);
  const rightParams = cursorModelParametersToObject(right);
  delete leftParams.fast;
  delete rightParams.fast;
  return JSON.stringify(leftParams) === JSON.stringify(rightParams);
}

function findCursorModelChoiceIgnoringFast(choices: CursorModelChoice[], model: string): string | undefined {
  const requestedParams = parseCursorModelParameters(model);
  if (requestedParams.get("fast") !== "true") return undefined;
  const baseModel = stripCursorParameterizedSuffix(model);
  return choices.find(
    (choice) =>
      stripCursorParameterizedSuffix(choice.slug) === baseModel &&
      parseCursorModelParameters(choice.slug).has("fast") &&
      cursorModelParametersEqualExceptFast(choice.slug, model),
  )?.slug;
}

function cursorModelChoiceSupportsRequestedParameters(choice: string, requested: string): boolean {
  if (stripCursorParameterizedSuffix(choice) !== stripCursorParameterizedSuffix(requested)) return false;
  const choiceParams = parseCursorModelParameters(choice);
  const requestedParams = parseCursorModelParameters(requested);
  for (const [key, requestedValue] of requestedParams) {
    const choiceValue = choiceParams.get(key);
    if (choiceValue === requestedValue) continue;
    if ((key === "fast" || key === "thinking") && requestedValue === "false") continue;
    return false;
  }
  return true;
}

function findCursorModelChoiceWithSupportedParameters(choices: CursorModelChoice[], model: string): string | undefined {
  return choices.find((choice) => cursorModelChoiceSupportsRequestedParameters(choice.slug, model))?.slug;
}

function cursorCliStyleOptionsMatch(
  choice: CursorModelChoice,
  requestedBaseModel: string,
  requestedOptions: CursorModelOptions | undefined,
): boolean {
  if (String(choice?.slug || "").includes("[")) return false;
  const choiceBase = normalizeCursorModelVariantBaseId(choice.slug);
  const requestedBase = normalizeCursorCliBaseModelId(requestedBaseModel);
  if (choiceBase !== requestedBase) return false;

  const choiceOptions = cursorModelOptionsFromCliModelId(choice.slug);
  if (requestedOptions?.reasoningEffort) {
    const left = normalizeCursorReasoningValue(choiceOptions.reasoningEffort);
    const right = normalizeCursorReasoningValue(requestedOptions.reasoningEffort);
    if (left && left !== right) return false;
  }
  if (requestedOptions?.contextWindow && choiceOptions.contextWindow) {
    if (normalizedText(choiceOptions.contextWindow) !== normalizedText(requestedOptions.contextWindow)) return false;
  }
  if (typeof requestedOptions?.fastMode === "boolean") {
    if (Boolean(choiceOptions.fastMode) !== requestedOptions.fastMode) return false;
  }
  if (typeof requestedOptions?.thinking === "boolean") {
    if (Boolean(choiceOptions.thinking) !== requestedOptions.thinking) return false;
  }
  return true;
}

function findCursorCliStyleVariantChoice(
  choices: CursorModelChoice[],
  baseModel: string,
  options: CursorModelOptions | undefined,
): string | undefined {
  return choices.find((choice) => cursorCliStyleOptionsMatch(choice, baseModel, options))?.slug;
}

export function resolveCursorAcpModelValue(
  configOptions: unknown,
  model: unknown,
  options?: CursorModelOptions | null,
): string | undefined {
  const trimmed = String(model || "").trim();
  if (!trimmed) return undefined;
  const choices = flattenCursorAcpModelChoices(Array.isArray(configOptions) ? configOptions : []);
  if (trimmed === "auto") return resolveCursorAutoModelValue(choices);

  const exactChoice = choices.find((choice) => choice.slug === trimmed);
  if (exactChoice) return exactChoice.slug;

  const baseModel = resolveCursorAcpBaseModelId(trimmed);
  if (baseModel === "auto") return undefined;
  const cliBaseModel = normalizeCursorCliBaseModelId(baseModel);
  const matchedAcpModelValue =
    choices.find((choice) => choice.slug === baseModel)?.slug ||
    choices.find((choice) => resolveCursorAcpBaseModelId(choice.slug) === baseModel)?.slug ||
    choices.find((choice) => resolveCursorAcpBaseModelId(choice.slug) === cliBaseModel)?.slug;
  const acpModelValue = matchedAcpModelValue || resolveCursorAutoModelValue(choices);
  if (!acpModelValue) return undefined;

  const inferredOptions = mergeCursorModelOptions(
    cursorModelOptionsFromModelParameters(trimmed),
    cursorModelOptionsFromCliModelId(trimmed),
    options ?? undefined,
  ) ?? {};
  const cliStyleVariant = findCursorCliStyleVariantChoice(choices, baseModel, inferredOptions);
  if (cliStyleVariant) return cliStyleVariant;

  const resolvedModel =
    buildCursorParameterizedModelFromOptions({
      acpModelValue,
      options: inferredOptions,
      choices,
      requestedModel: trimmed,
    }) || acpModelValue;

  if (choices.some((choice) => choice.slug === resolvedModel)) return resolvedModel;
  const matchedChoice =
    findCursorModelChoiceIgnoringFast(choices, resolvedModel) ||
    findCursorModelChoiceWithSupportedParameters(choices, resolvedModel);
  if (matchedChoice) return matchedChoice;
  if (
    trimmed.includes("[") &&
    stripCursorParameterizedSuffix(trimmed) === stripCursorParameterizedSuffix(acpModelValue)
  ) {
    const bracketCandidate = resolvedModel.includes("[") ? resolvedModel : trimmed;
    if (choices.some((choice) => choice.slug === bracketCandidate)) return bracketCandidate;
    const bracketParams = parseCursorModelParameters(bracketCandidate);
    const optionBackedOnly = [...bracketParams.keys()].every((key) =>
      key === "fast" || key === "thinking" || key === "context",
    );
    if (optionBackedOnly && choices.some((choice) => choice.slug === acpModelValue)) {
      return acpModelValue;
    }
    if (optionBackedOnly && choices.some((choice) => stripCursorParameterizedSuffix(choice.slug) === baseModel)) {
      return acpModelValue.includes("[") ? stripCursorParameterizedSuffix(acpModelValue) : acpModelValue;
    }
    return acpModelValue.includes("[") ? stripCursorParameterizedSuffix(acpModelValue) : acpModelValue;
  }
  return acpModelValue.includes("[") ? resolvedModel : acpModelValue;
}

export function modelSupportsAcpReasoningConfig(configOptions: unknown, modelValue: unknown): boolean {
  const options = Array.isArray(configOptions) ? (configOptions as CursorConfigOption[]) : [];
  const baseModel = stripCursorParameterizedSuffix(String(modelValue || "").trim());
  if (!baseModel || baseModel === "auto") return false;
  if (/^composer(?:[-[]|$)/u.test(baseModel)) return false;

  const choices = flattenCursorAcpModelChoices(Array.isArray(configOptions) ? configOptions : []);
  const reasoningInChoices = choices.some((choice) => {
    if (stripCursorParameterizedSuffix(choice.slug) !== baseModel) return false;
    const params = parseCursorModelParameters(choice.slug);
    return params.has("reasoning") || params.has("effort");
  });
  if (reasoningInChoices) return true;
  return Boolean(findConfigOption(options, ["effort", "reasoning", "thought level"]));
}

export function validateCursorAcpModelValue(configOptions: unknown, modelValue: unknown): string | null {
  const trimmed = String(modelValue || "").trim();
  if (!trimmed) return null;
  const choices = flattenCursorAcpModelChoices(Array.isArray(configOptions) ? configOptions : []);
  if (choices.length === 0) return null;
  if (choices.some((choice) => choice.slug === trimmed)) return null;
  if (findCursorModelChoiceIgnoringFast(choices, trimmed)) return null;
  if (findCursorModelChoiceWithSupportedParameters(choices, trimmed)) return null;

  const baseModel = stripCursorParameterizedSuffix(trimmed);
  if (!choices.some((choice) => stripCursorParameterizedSuffix(choice.slug) === baseModel)) {
    return `Invalid params: Invalid model value: ${trimmed}`;
  }

  const params = parseCursorModelParameters(trimmed);
  if (params.has("reasoning") || params.has("effort")) {
    if (!modelSupportsAcpReasoningConfig(configOptions, trimmed)) {
      return `Invalid params: Invalid model value: ${trimmed}`;
    }
    const reasoningInChoices = choices.some((choice) => {
      if (stripCursorParameterizedSuffix(choice.slug) !== baseModel) return false;
      const choiceParams = parseCursorModelParameters(choice.slug);
      return choiceParams.has("reasoning") || choiceParams.has("effort");
    });
    const hasReasoningConfig = Boolean(
      findConfigOption(
        Array.isArray(configOptions) ? (configOptions as CursorConfigOption[]) : [],
        ["effort", "reasoning", "thought level"],
      ),
    );
    if (!reasoningInChoices && !hasReasoningConfig) {
      return `Invalid params: Invalid model value: ${trimmed}`;
    }
  }

  return null;
}

function toConfigValue(option: CursorConfigOption, value: unknown): unknown {
  if (option.type === "boolean") {
    return typeof value === "boolean" ? value : String(value).trim().toLowerCase() === "true";
  }
  if (option.type !== "select") return undefined;
  const stringValue = String(value).trim();
  if (!stringValue) return undefined;
  const normalized = normalizedText(stringValue);
  const normalizedAliases =
    normalized === "xhigh" || normalized === "extra high"
      ? new Set([normalized, "xhigh", "extra high"])
      : new Set([normalized]);

  for (const entry of option.options || []) {
    const candidates =
      typeof entry?.value === "string"
        ? [{ value: entry.value, name: entry.name }]
        : Array.isArray(entry?.options)
          ? entry.options.map((nested: CursorSelectOptionEntry) => ({ value: nested.value, name: nested.name }))
          : [];
    for (const candidate of candidates) {
      if (
        normalizedAliases.has(normalizedText(candidate.value)) ||
        normalizedAliases.has(normalizedText(candidate.name))
      ) {
        return candidate.value;
      }
    }
  }
  return undefined;
}

export function collectCursorAcpConfigUpdates(
  configOptions: unknown,
  options: CursorModelOptions | undefined,
  modelValue: unknown,
): Array<{ configId: string; value: unknown }> {
  if (!options) return [];
  const source = Array.isArray(configOptions) ? (configOptions as CursorConfigOption[]) : [];
  const updates: Array<{ configId: string; value: unknown }> = [];
  const pushUpdate = (aliases: string[], value: unknown) => {
    if (value === undefined) return;
    const option = findConfigOption(source, aliases);
    if (!option) return;
    const configValue = toConfigValue(option, value);
    if (configValue === undefined) return;
    updates.push({ configId: option.id ?? "model", value: configValue });
  };

  if (modelSupportsAcpReasoningConfig(source, modelValue)) {
    pushUpdate(["effort", "reasoning", "thought level"], options.reasoningEffort);
  }
  pushUpdate(["context", "context size", "context window"], options.contextWindow);
  pushUpdate(["fast", "fast mode"], options.fastMode);
  pushUpdate(["thinking"], options.thinking);
  return updates;
}

export function modelConfigId(configOptions: unknown): string {
  return findModelConfig(Array.isArray(configOptions) ? (configOptions as CursorConfigOption[]) : [])?.id || "model";
}
