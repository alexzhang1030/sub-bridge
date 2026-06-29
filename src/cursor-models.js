export const CURSOR_LIST_AVAILABLE_MODELS_METHOD = "cursor/list_available_models";

function normalizedText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function stripCursorParameterizedSuffix(value) {
  const trimmed = String(value || "").trim();
  const suffixStart = trimmed.indexOf("[");
  return suffixStart >= 0 ? trimmed.slice(0, suffixStart).trim() : trimmed;
}

function parseCursorModelParameters(value) {
  const match = String(value || "").match(/\[([^\]]*)\]$/u);
  if (!match?.[1]) return new Map();
  const params = new Map();
  for (const part of match[1].split(",")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = part.slice(0, separatorIndex).trim();
    const paramValue = part.slice(separatorIndex + 1).trim();
    if (key && paramValue) params.set(key, paramValue);
  }
  return params;
}

function cursorModelParametersToObject(value) {
  return Object.fromEntries(parseCursorModelParameters(value).entries());
}

function buildCursorParameterizedModelSlug(baseModel, params) {
  const entries = Object.entries(params).filter(([, value]) => String(value || "").trim());
  if (entries.length === 0) return baseModel;
  return `${baseModel}[${entries.map(([key, value]) => `${key}=${value}`).join(",")}]`;
}

function flattenSelectOptions(option) {
  if (!option || option.type !== "select" || !Array.isArray(option.options)) return [];
  return option.options.flatMap((entry) => {
    if (typeof entry?.value === "string") {
      return [{ value: entry.value.trim(), name: String(entry.name || entry.value).trim() }];
    }
    if (Array.isArray(entry?.options)) {
      return entry.options.flatMap((child) =>
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

function findModelConfig(configOptions) {
  return (
    configOptions.find((option) => option?.category === "model" && typeof option.id === "string") ||
    configOptions.find((option) => option?.id === "model")
  );
}

function findConfigOption(configOptions, aliases) {
  const normalizedAliases = aliases.map(normalizedText);
  return configOptions.find((option) => {
    const haystack = normalizedText(`${option?.id || ""} ${option?.name || ""} ${option?.category || ""}`);
    return normalizedAliases.some((alias) => haystack.includes(alias));
  });
}

function humanizeCursorModelName(value) {
  const base = stripCursorParameterizedSuffix(value);
  if (!base) return value;
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

function normalizeCursorAcpModelName(choice) {
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

function inferCursorUpstreamProvider(choice) {
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

function flattenCursorAcpModelChoices(configOptions) {
  const seen = new Set();
  const choices = [];
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

export function normalizeCursorReasoningValue(value) {
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

function cursorReasoningParameterValue(value) {
  return value === "xhigh" ? "extra-high" : value;
}

function cursorReasoningLabel(value) {
  if (value === "xhigh") return "Extra High";
  if (value === "max") return "Max";
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function findCursorEffortConfigOption(configOptions) {
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

function isCursorContextConfigOption(option) {
  const id = String(option?.id || "").trim().toLowerCase();
  const name = String(option?.name || "").trim().toLowerCase();
  return id === "context" || id === "context_size" || name.includes("context");
}

function findCursorContextConfigOption(configOptions) {
  return configOptions.find((option) => option?.category === "model_config" && isCursorContextConfigOption(option)) ||
    configOptions.find(isCursorContextConfigOption);
}

function findCursorBooleanOption(configOptions, id) {
  return configOptions.find((option) => String(option?.id || "").trim().toLowerCase() === id);
}

function contextWindowTokens(value, fallback = 128000) {
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

function cursorContextWindowLabel(value) {
  const normalized = String(value || "").trim();
  return normalized.toLowerCase() === "1m" ? "1M" : normalized.toUpperCase();
}

function buildModelEntry(input) {
  const id = input.id === "default" ? "auto" : input.id;
  const entry = {
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

export function cursorModelsFromConfigOptions(configOptions) {
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

export function cursorModelsFromAvailableModels(models) {
  const seen = new Set();
  const entries = [];
  for (const model of Array.isArray(models) ? models : []) {
    const rawId = String(model?.value || model?.id || "").trim();
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

export function parseCursorCliModelList(stdout) {
  const seen = new Set();
  const models = [];
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
      ...options,
    });
  }
  return models;
}

function normalizeCursorCliBaseModelId(model) {
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

export function normalizeCursorModelVariantBaseId(model) {
  return normalizeCursorCliBaseModelId(stripCursorParameterizedSuffix(model));
}

function parseCursorCliReasoningEffort(model) {
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

function isCursorCliOneMillionContextModel(model) {
  const normalized = String(model || "").trim().toLowerCase();
  return (
    normalized.startsWith("gpt-5.5-") ||
    /^gpt-5\.4-(?:low|medium|high|xhigh|extra-high)$/u.test(normalized) ||
    /^claude-4\.6-(?:opus|sonnet)(?:-|$)/u.test(normalized) ||
    /^claude-(?:fable-5|opus-4-(?:7|8))-/u.test(normalized)
  );
}

export function cursorModelOptionsFromCliModelId(model) {
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

function uniqueByValue(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (!value?.value || seen.has(value.value)) continue;
    seen.add(value.value);
    result.push(value);
  }
  return result;
}

function removeVariantNameSuffix(name) {
  return String(name || "")
    .replace(/\s+Fast$/iu, "")
    .replace(/\s+Thinking$/iu, "")
    .replace(/\s+Fast$/iu, "")
    .replace(/\s+(?:None|Low|Medium|High|Extra High|Max)$/iu, "")
    .replace(/\s+1M$/u, "")
    .trim();
}

function defaultEffortForCursorGroup(baseId, efforts) {
  if (efforts.length === 0) return "";
  if (baseId.includes("gpt") || baseId.includes("codex")) return efforts.includes("medium") ? "medium" : efforts[0];
  if (baseId.includes("claude")) return efforts.includes("high") ? "high" : efforts[0];
  return efforts[0];
}

function isCursorOneMillionVariant(model) {
  if (model.defaultContextWindow === "1m") return true;
  if (model.contextWindowOptions?.some((option) => option.value === "1m" && option.isDefault === true)) return true;
  return /\b1M\b/u.test(model.displayName || "");
}

function fallbackContextWindowOptionsForCursorBase(baseId, variants) {
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

function cursorVariantDisplayName(baseName, { contextWindow, reasoningEffort, fastMode, thinking }) {
  const parts = [removeVariantNameSuffix(baseName) || baseName];
  if (contextWindow) parts.push(cursorContextWindowLabel(contextWindow));
  if (reasoningEffort) parts.push(cursorReasoningLabel(reasoningEffort));
  if (thinking) parts.push("Thinking");
  if (fastMode) parts.push("Fast");
  return parts.filter(Boolean).join(" ");
}

function cursorVariantId(baseId, { contextWindow, reasoningEffort, fastMode, thinking }) {
  const params = {};
  if (contextWindow) params.context = contextWindow;
  if (reasoningEffort) params.effort = cursorReasoningParameterValue(reasoningEffort);
  if (fastMode) params.fast = "true";
  if (thinking) params.thinking = "true";
  return buildCursorParameterizedModelSlug(baseId, params);
}

function cursorVariantOptionsForModel(model) {
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

function generatedCursorVariantsForModel(model) {
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
  const variants = [];
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

export function collapseCursorModelVariants(models) {
  const groups = new Map();
  for (const model of Array.isArray(models) ? models : []) {
    const baseId = normalizeCursorModelVariantBaseId(model.id) || model.id;
    const group = groups.get(baseId);
    if (group) group.push(model);
    else groups.set(baseId, [model]);
  }

  return Array.from(groups.entries()).map(([baseId, variants]) => {
    const preferred =
      variants.find((variant) => variant.id === baseId) ||
      variants.find((variant) => !variant.id.endsWith("-fast")) ||
      variants[0];
    const efforts = uniqueByValue(variants.flatMap((variant) => [
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
      variants.find((variant) => normalizeCursorModelVariantBaseId(variant.id) === variant.id)?.defaultReasoningEffort ||
      defaultEffortForCursorGroup(baseId, effortValues);
    const contextWindowOptions = uniqueByValue([
      ...fallbackContextWindowOptionsForCursorBase(baseId, variants),
      ...variants.flatMap((variant) => variant.contextWindowOptions || []),
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
      supportsFastMode: variants.some((variant) => variant.supportsFastMode === true),
      supportsThinking: variants.some((variant) => variant.supportsThinking === true),
      contextWindowOptions,
      defaultContextWindow:
        contextWindowOptions.find((option) => option.isDefault)?.value ||
        contextWindowOptions[0]?.value ||
        preferred?.defaultContextWindow,
    });
  });
}

export function mergeCursorModelVariantsWithBaseControls(models) {
  const normalized = Array.isArray(models) ? models : [];
  const expanded = normalized.flatMap((model) => [model, ...generatedCursorVariantsForModel(model)]);
  const seen = new Set();
  const merged = [];
  for (const model of [...collapseCursorModelVariants(expanded), ...expanded]) {
    const key = String(model?.id || "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(model);
  }
  return merged;
}

export function cursorModelGroupEntries(model) {
  const providerId = String(model?.upstreamProviderId || "cursor").trim().toLowerCase() || "cursor";
  const providerName = String(model?.upstreamProviderName || "Cursor").trim() || "Cursor";
  const familyId = normalizeCursorModelVariantBaseId(model?.id) || String(model?.id || "").trim();
  const familyName = removeVariantNameSuffix(model?.displayName || humanizeCursorModelName(familyId));
  return [
    { id: `provider:${providerId}`, type: "provider", name: providerName },
    { id: `family:${familyId}`, type: "family", name: familyName },
  ];
}

export function normalizeModelGroupsConfig(config) {
  const disabled = Array.isArray(config?.disabled) ? config.disabled : [];
  const only = Array.isArray(config?.only) ? config.only : [];
  return {
    disabled: Array.from(new Set(disabled.map((value) => String(value || "").trim()).filter(Boolean))).sort(),
    only: Array.from(new Set(only.map((value) => String(value || "").trim()).filter(Boolean))),
  };
}

export function filterCursorModelsByGroups(models, config) {
  const groupsConfig = normalizeModelGroupsConfig(config);
  const disabled = new Set(groupsConfig.disabled);
  const only = new Set(groupsConfig.only);
  const normalized = Array.isArray(models) ? models : [];
  if (disabled.size === 0 && only.size === 0) return normalized;
  const onlyOrder = new Map(groupsConfig.only.map((groupId, index) => [groupId, index]));
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
  return filtered
    .sort((left, right) => left.groupOrder - right.groupOrder || left.index - right.index)
    .map((entry) => entry.model);
}

export function summarizeCursorModelGroups(models, config) {
  const groupsConfig = normalizeModelGroupsConfig(config);
  const disabled = new Set(groupsConfig.disabled);
  const only = new Set(groupsConfig.only);
  const filtered = new Set(filterCursorModelsByGroups(models, config).map((model) => String(model?.id || "").trim()));
  const byId = new Map();
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

function cursorModelOptionsFromModelParameters(model) {
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

export function cursorOptionsFromModelEntry(model) {
  if (!model || typeof model !== "object") return {};
  const explicitContextWindow = model.cursorContextWindow || model.cursorContext || model.contextOption;
  const defaultContextWindow = model.defaultContextWindow;
  const rawReasoningEffort = model.reasoningEffort || model.defaultReasoningEffort;
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
    ...(typeof model.fastMode === "boolean"
      ? { fastMode: model.fastMode }
      : fastModeFromReasoning !== undefined
        ? { fastMode: fastModeFromReasoning }
        : {}),
    ...(typeof model.thinking === "boolean" ? { thinking: model.thinking } : {}),
  };
}

export function mergeCursorModelOptions(...sources) {
  const merged = {};
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    if (source.reasoningEffort) merged.reasoningEffort = source.reasoningEffort;
    if (source.contextWindow) merged.contextWindow = source.contextWindow;
    if (typeof source.fastMode === "boolean") merged.fastMode = source.fastMode;
    if (typeof source.thinking === "boolean") merged.thinking = source.thinking;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function cursorAcpParameterKeyForModel(baseModel, options) {
  if (options?.reasoningEffort && String(baseModel || "").includes("claude")) return "effort";
  return "reasoning";
}

function cursorChoiceMatchesBase(choice, baseModel) {
  const choiceBase = resolveCursorAcpBaseModelId(choice.slug);
  const cliBaseModel = normalizeCursorCliBaseModelId(baseModel);
  return choiceBase === baseModel || choiceBase === cliBaseModel;
}

function cursorParameterValuesMatch(key, left, right) {
  if (key === "reasoning" || key === "effort") {
    return normalizeCursorReasoningValue(left) === normalizeCursorReasoningValue(right);
  }
  return normalizedText(left) === normalizedText(right);
}

function resolveCursorChoiceParameterValue({ choices, baseModel, key, requestedValue }) {
  let sawParameterizedChoice = false;
  for (const choice of choices) {
    if (!cursorChoiceMatchesBase(choice, baseModel)) continue;
    const value = parseCursorModelParameters(choice.slug).get(key);
    if (!value) continue;
    sawParameterizedChoice = true;
    if (cursorParameterValuesMatch(key, value, requestedValue)) return value;
  }
  return sawParameterizedChoice ? undefined : requestedValue;
}

function buildCursorParameterizedModelFromOptions({ acpModelValue, options, choices }) {
  if (!acpModelValue.includes("[") || !options || Object.keys(options).length === 0) return undefined;
  const baseModel = stripCursorParameterizedSuffix(acpModelValue);
  const params = cursorModelParametersToObject(acpModelValue);
  if (options.reasoningEffort) {
    const parameterKey = cursorAcpParameterKeyForModel(baseModel, options);
    params[parameterKey] =
      resolveCursorChoiceParameterValue({
        choices,
        baseModel,
        key: parameterKey,
        requestedValue: options.reasoningEffort,
      }) || cursorReasoningParameterValue(options.reasoningEffort);
  }
  if (options.contextWindow) params.context = options.contextWindow;
  if (typeof options.fastMode === "boolean") params.fast = String(options.fastMode);
  if (typeof options.thinking === "boolean") params.thinking = String(options.thinking);
  return buildCursorParameterizedModelSlug(baseModel, params);
}

export function resolveCursorAcpBaseModelId(model) {
  const trimmed = String(model || "").trim();
  if (!trimmed || trimmed === "auto") return "auto";
  return stripCursorParameterizedSuffix(trimmed) || "auto";
}

function resolveCursorAutoModelValue(choices) {
  return (
    choices.find((choice) => choice.slug.trim().toLowerCase() === "auto")?.slug ||
    choices.find((choice) => choice.slug.trim().toLowerCase() === "default")?.slug ||
    choices.find((choice) => normalizedText(choice.name) === "auto")?.slug
  );
}

function cursorModelParametersEqualExceptFast(left, right) {
  const leftParams = cursorModelParametersToObject(left);
  const rightParams = cursorModelParametersToObject(right);
  delete leftParams.fast;
  delete rightParams.fast;
  return JSON.stringify(leftParams) === JSON.stringify(rightParams);
}

function findCursorModelChoiceIgnoringFast(choices, model) {
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

function cursorModelChoiceSupportsRequestedParameters(choice, requested) {
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

function findCursorModelChoiceWithSupportedParameters(choices, model) {
  return choices.find((choice) => cursorModelChoiceSupportsRequestedParameters(choice.slug, model))?.slug;
}

export function resolveCursorAcpModelValue(configOptions, model, options) {
  const trimmed = String(model || "").trim();
  if (!trimmed) return undefined;
  const choices = flattenCursorAcpModelChoices(Array.isArray(configOptions) ? configOptions : []);
  if (trimmed === "auto") return resolveCursorAutoModelValue(choices);

  const exactChoice = choices.find((choice) => choice.slug === trimmed);
  if (exactChoice) return exactChoice.slug;

  const baseModel = resolveCursorAcpBaseModelId(trimmed);
  if (baseModel === "auto") return undefined;
  const cliBaseModel = normalizeCursorCliBaseModelId(baseModel);
  const acpModelValue =
    choices.find((choice) => choice.slug === baseModel)?.slug ||
    choices.find((choice) => resolveCursorAcpBaseModelId(choice.slug) === baseModel)?.slug ||
    choices.find((choice) => resolveCursorAcpBaseModelId(choice.slug) === cliBaseModel)?.slug ||
    baseModel;

  const inferredOptions = mergeCursorModelOptions(
    cursorModelOptionsFromModelParameters(trimmed),
    cursorModelOptionsFromCliModelId(trimmed),
    options,
  );
  const resolvedModel =
    buildCursorParameterizedModelFromOptions({
      acpModelValue,
      options: inferredOptions,
      choices,
    }) || acpModelValue;

  if (choices.some((choice) => choice.slug === resolvedModel)) return resolvedModel;
  return (
    findCursorModelChoiceIgnoringFast(choices, resolvedModel) ||
    findCursorModelChoiceWithSupportedParameters(choices, resolvedModel) ||
    resolvedModel
  );
}

function toConfigValue(option, value) {
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
          ? entry.options.map((nested) => ({ value: nested.value, name: nested.name }))
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

export function collectCursorAcpConfigUpdates(configOptions, options) {
  if (!options) return [];
  const source = Array.isArray(configOptions) ? configOptions : [];
  const updates = [];
  const pushUpdate = (aliases, value) => {
    if (value === undefined) return;
    const option = findConfigOption(source, aliases);
    if (!option) return;
    const configValue = toConfigValue(option, value);
    if (configValue === undefined) return;
    updates.push({ configId: option.id, value: configValue });
  };

  pushUpdate(["effort", "reasoning", "thought level"], options.reasoningEffort);
  pushUpdate(["context", "context size", "context window"], options.contextWindow);
  pushUpdate(["fast", "fast mode"], options.fastMode);
  pushUpdate(["thinking"], options.thinking);
  return updates;
}

export function modelConfigId(configOptions) {
  return findModelConfig(Array.isArray(configOptions) ? configOptions : [])?.id || "model";
}
