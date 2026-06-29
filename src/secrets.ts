import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SecretName = {
  CODEX_CLIENT_ID: "codex_client_id",
  CODEX_CLIENT_SECRET: "codex_client_secret",
  CURSOR_AUTH_TOKEN: "cursor_auth_token",
  BRIDGE_KEY: "bridge_key",
} as const;

export type SecretNameValue = (typeof SecretName)[keyof typeof SecretName];

type VaultPayload = {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
};

type VaultDocument = {
  version: 1;
  secrets: Partial<Record<SecretNameValue, VaultPayload>>;
};

export type SecretSource = "env" | "vault" | "legacy" | "missing";

export type ResolvedSecret = {
  value: string;
  source: SecretSource;
};

function envValue(...keys: string[]): string | undefined {
  for (const key of keys) {
    if (process.env[key] !== undefined) return process.env[key];
  }
  return undefined;
}

function ensurePrivateDir(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {}
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {}
}

function masterKeyPath(secretsDir: string) {
  return join(secretsDir, "key");
}

function vaultPath(secretsDir: string) {
  return join(secretsDir, "vault.enc");
}

function legacyCursorTokenPath(secretsDir: string) {
  return join(secretsDir, "token.enc");
}

function readOrCreateMasterKey(secretsDir: string) {
  ensurePrivateDir(secretsDir);
  const keyPath = masterKeyPath(secretsDir);
  if (existsSync(keyPath)) {
    const key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
    if (key.length === 32) return key;
  }
  const key = randomBytes(32);
  writeFileSync(keyPath, `${key.toString("base64")}\n`, { mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {}
  return key;
}

function encryptValue(secretsDir: string, value: string): VaultPayload {
  const key = readOrCreateMasterKey(secretsDir);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptValue(secretsDir: string, payload: VaultPayload): string {
  const key = readOrCreateMasterKey(secretsDir);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function readVault(secretsDir: string): VaultDocument {
  const path = vaultPath(secretsDir);
  if (!existsSync(path)) return { version: 1, secrets: {} };
  return readJson<VaultDocument>(path);
}

function writeVault(secretsDir: string, vault: VaultDocument) {
  writeJson(vaultPath(secretsDir), vault);
}

function decryptLegacyCursorToken(secretsDir: string): string {
  const path = legacyCursorTokenPath(secretsDir);
  if (!existsSync(path)) return "";
  const payload = readJson<VaultPayload>(path);
  return decryptValue(secretsDir, payload);
}

export function saveSecret(secretsDir: string, name: SecretNameValue, value: string) {
  const clean = String(value || "").trim();
  if (!clean) throw new Error(`Secret ${name} is empty`);
  const vault = readVault(secretsDir);
  vault.secrets[name] = encryptValue(secretsDir, clean);
  writeVault(secretsDir, vault);
  if (name === SecretName.CURSOR_AUTH_TOKEN && existsSync(legacyCursorTokenPath(secretsDir))) {
    try {
      unlinkSync(legacyCursorTokenPath(secretsDir));
    } catch {}
  }
}

export function deleteSecret(secretsDir: string, name: SecretNameValue) {
  const vault = readVault(secretsDir);
  delete vault.secrets[name];
  if (Object.keys(vault.secrets).length === 0) {
    for (const path of [vaultPath(secretsDir), masterKeyPath(secretsDir)]) {
      if (existsSync(path)) {
        try {
          unlinkSync(path);
        } catch {}
      }
    }
  } else {
    writeVault(secretsDir, vault);
  }
  if (name === SecretName.CURSOR_AUTH_TOKEN && existsSync(legacyCursorTokenPath(secretsDir))) {
    try {
      unlinkSync(legacyCursorTokenPath(secretsDir));
    } catch {}
  }
}

export function listStoredSecrets(secretsDir: string): SecretNameValue[] {
  const names = new Set<SecretNameValue>(Object.keys(readVault(secretsDir).secrets) as SecretNameValue[]);
  if (existsSync(legacyCursorTokenPath(secretsDir))) names.add(SecretName.CURSOR_AUTH_TOKEN);
  return [...names].sort();
}

export function resolveSecret(
  secretsDir: string,
  name: SecretNameValue,
  envKeys: string[],
  { required = false }: { required?: boolean } = {},
): ResolvedSecret {
  const fromEnv = envValue(...envKeys);
  if (fromEnv && String(fromEnv).trim()) {
    return { value: String(fromEnv).trim(), source: "env" };
  }

  const vaultEntry = readVault(secretsDir).secrets[name];
  if (vaultEntry) {
    return { value: decryptValue(secretsDir, vaultEntry), source: "vault" };
  }

  if (name === SecretName.CURSOR_AUTH_TOKEN) {
    const legacy = decryptLegacyCursorToken(secretsDir);
    if (legacy) return { value: legacy, source: "legacy" };
  }

  if (required) {
    throw new Error(
      `Missing secret ${name}. Set ${envKeys[0] || `SUB_BRIDGE_${name.toUpperCase()}`} or run: sub-bridge secrets set ${name} <value>`,
    );
  }
  return { value: "", source: "missing" };
}

export function secretConfigured(secretsDir: string, name: SecretNameValue, envKeys: string[]): boolean {
  return resolveSecret(secretsDir, name, envKeys).source !== "missing";
}

export function secretDoctorEntry(
  secretsDir: string,
  name: SecretNameValue,
  envKeys: string[],
): { configured: boolean; source: SecretSource } {
  const resolved = resolveSecret(secretsDir, name, envKeys);
  return { configured: resolved.source !== "missing", source: resolved.source };
}

export const CODEX_TOKEN_URL_DEFAULT = "https://auth.openai.com/oauth/token";

export function resolveCodexTokenUrl(envKeys: string[]): string {
  return envValue(...envKeys)?.trim() || CODEX_TOKEN_URL_DEFAULT;
}
