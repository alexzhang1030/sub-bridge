import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CURSOR_AGENT_BROWSERLESS_ENV = {
  NO_BROWSER: "true",
  BROWSER: "www-browser",
} as const;

export const CURSOR_AGENT_HEADLESS_PROBE_ENV = {
  ...CURSOR_AGENT_BROWSERLESS_ENV,
  CI: "1",
  DEBIAN_FRONTEND: "noninteractive",
} as const;

export function defaultCursorAcpCommand(): string {
  const localAgent = join(homedir(), ".local", "bin", "agent");
  return existsSync(localAgent) ? localAgent : "agent";
}

export function makeCursorEnv({
  baseEnv = process.env,
  forceCi = true,
  browserless = true,
}: {
  baseEnv?: NodeJS.ProcessEnv;
  forceCi?: boolean;
  browserless?: boolean;
} = {}): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    ...(browserless ? CURSOR_AGENT_BROWSERLESS_ENV : {}),
    ...(forceCi ? { CI: "1", DEBIAN_FRONTEND: "noninteractive" } : {}),
  };
}

export function makeCursorProbeEnv({ baseEnv = process.env }: { baseEnv?: NodeJS.ProcessEnv } = {}): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    ...CURSOR_AGENT_HEADLESS_PROBE_ENV,
  };
}
