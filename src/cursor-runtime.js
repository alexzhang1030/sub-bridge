import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CURSOR_AGENT_BROWSERLESS_ENV = {
  NO_BROWSER: "true",
  BROWSER: "www-browser",
};

export const CURSOR_AGENT_HEADLESS_PROBE_ENV = {
  ...CURSOR_AGENT_BROWSERLESS_ENV,
  CI: "1",
  DEBIAN_FRONTEND: "noninteractive",
};

export function defaultCursorAcpCommand() {
  const localAgent = join(homedir(), ".local", "bin", "agent");
  return existsSync(localAgent) ? localAgent : "agent";
}

export function makeCursorEnv({ baseEnv = process.env, forceCi = true, browserless = true } = {}) {
  return {
    ...baseEnv,
    ...(browserless ? CURSOR_AGENT_BROWSERLESS_ENV : {}),
    ...(forceCi ? { CI: "1", DEBIAN_FRONTEND: "noninteractive" } : {}),
  };
}

export function makeCursorProbeEnv({ baseEnv = process.env } = {}) {
  return {
    ...baseEnv,
    ...CURSOR_AGENT_HEADLESS_PROBE_ENV,
  };
}
