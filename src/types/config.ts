export interface ModelGroupsConfig {
  disabled?: string[];
  only?: string[];
  preset?: string;
}

export interface SubscriptionConfig {
  type?: string;
  host?: string;
  port?: number;
  models?: unknown;
  modelGroups?: ModelGroupsConfig;
  providerId?: string;
  providerName?: string;
  authPath?: string;
  copilotDb?: string;
  stateDir?: string;
  pidPath?: string;
  logPath?: string;
  usePi?: boolean | string;
  piDir?: string;
  piTransport?: string;
  timeoutMs?: number;
  stripTools?: boolean | string;
  syncResponses?: boolean | string;
  copilotSseDataOnly?: boolean | string;
  wireApi?: string;
  cursorCommand?: string;
  cursorWorkspace?: string;
  cursorModel?: string;
  originator?: string;
}

export interface ConfigFile {
  subscriptions?: Record<string, SubscriptionConfig>;
  [key: string]: unknown;
}

export type ConfigValue = string | number | boolean | undefined;
