import { join } from "node:path";
import { ensurePrivateDir } from "../lib/http";
import { deleteSecret, resolveSecret, SecretName } from "../../secrets";

type CursorEnvFactory = (options: { forceCi: boolean }) => Record<string, string>;

export function loadCursorAuthToken(secretsDir: string, envKeys: string[]) {
  return resolveSecret(secretsDir, SecretName.CURSOR_AUTH_TOKEN, envKeys).value;
}

export function cursorAuthTokenPresent(secretsDir: string, envKeys: string[]) {
  return resolveSecret(secretsDir, SecretName.CURSOR_AUTH_TOKEN, envKeys).source !== "missing";
}

export function removeCursorAuthToken(secretsDir: string) {
  deleteSecret(secretsDir, SecretName.CURSOR_AUTH_TOKEN);
}

export function cursorLocalEnvDirs(cursorLocalAuthDir: string) {
  return {
    configDir: join(cursorLocalAuthDir, "config"),
    dataDir: join(cursorLocalAuthDir, "data"),
    xdgConfigHome: join(cursorLocalAuthDir, "xdg-config"),
  };
}

export function makeBridgeCursorEnv(options: {
  secretsDir: string;
  cursorLocalAuthDir: string;
  cursorForceCi: boolean;
  envKeys: string[];
  includeToken?: boolean;
  makeCursorEnv: CursorEnvFactory;
}) {
  const { secretsDir, cursorLocalAuthDir, cursorForceCi, envKeys, includeToken = true, makeCursorEnv } = options;
  const dirs = cursorLocalEnvDirs(cursorLocalAuthDir);
  for (const path of Object.values(dirs)) ensurePrivateDir(path);
  const env = makeCursorEnv({ forceCi: cursorForceCi });
  env.AGENT_CLI_CREDENTIAL_STORE = "memory";
  env.CURSOR_CONFIG_DIR = dirs.configDir;
  env.CURSOR_DATA_DIR = dirs.dataDir;
  env.XDG_CONFIG_HOME = dirs.xdgConfigHome;
  if (includeToken) {
    const token = loadCursorAuthToken(secretsDir, envKeys);
    if (token) env.CURSOR_AUTH_TOKEN = token;
  }
  return env;
}

export function makeCursorRuntimeEnv(options: {
  secretsDir: string;
  cursorLocalAuthDir: string;
  cursorForceCi: boolean;
  envKeys: string[];
  makeCursorEnv: CursorEnvFactory;
}) {
  return cursorAuthTokenPresent(options.secretsDir, options.envKeys)
    ? makeBridgeCursorEnv(options)
    : options.makeCursorEnv({ forceCi: options.cursorForceCi });
}
