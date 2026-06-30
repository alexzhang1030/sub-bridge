export interface CursorSelectOptionEntry {
  value?: string;
  name?: string;
  group?: string;
  options?: CursorSelectOptionEntry[];
}

export interface CursorConfigOption {
  id?: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: unknown;
  options?: CursorSelectOptionEntry[];
}

export interface CursorReasoningEffort {
  value: string;
  label?: string;
  isDefault?: boolean;
}

export interface CursorContextWindowOption {
  value: string;
  label?: string;
  isDefault?: boolean;
}

export interface CursorModelEntry {
  id: string;
  displayName: string;
  contextWindow: number;
  maxTokens: number;
  upstreamProviderId?: string;
  upstreamProviderName?: string;
  supportedReasoningEfforts?: CursorReasoningEffort[];
  defaultReasoningEffort?: string;
  supportsFastMode?: boolean;
  supportsThinking?: boolean;
  contextWindowOptions?: CursorContextWindowOption[];
  defaultContextWindow?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  thinking?: boolean;
  cursorContextWindow?: string;
  cursorContext?: string;
  contextOption?: string;
}

export interface CursorModelChoice {
  slug: string;
  name: string;
  groupId?: string;
  groupName?: string;
  upstreamProviderId?: string;
  upstreamProviderName?: string;
}

export interface CursorModelOptions {
  reasoningEffort?: string;
  contextWindow?: string;
  fastMode?: boolean;
  thinking?: boolean;
}

export interface CursorModelGroupEntry {
  id: string;
  type: string;
  name: string;
}

export interface CursorModelGroupSummary extends CursorModelGroupEntry {
  modelCount: number;
  activeModelCount: number;
  selected: boolean;
  enabled: boolean;
}
