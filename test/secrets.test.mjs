import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  SecretName,
  listStoredSecrets,
  resolveSecret,
  saveSecret,
  secretConfigured,
} from "../src/secrets.ts";

test("secrets store and resolve encrypted values without persisting plaintext", () => {
  const dir = mkdtempSync(join(tmpdir(), "sub-bridge-secrets-"));
  try {
    saveSecret(dir, SecretName.CODEX_CLIENT_ID, "app_test_client");
    assert.equal(secretConfigured(dir, SecretName.CODEX_CLIENT_ID, ["SUB_BRIDGE_CODEX_CLIENT_ID"]), true);
    const resolved = resolveSecret(dir, SecretName.CODEX_CLIENT_ID, ["SUB_BRIDGE_CODEX_CLIENT_ID"]);
    assert.equal(resolved.value, "app_test_client");
    assert.equal(resolved.source, "vault");
    const vaultText = readFileSync(join(dir, "vault.enc"), "utf8");
    assert.equal(vaultText.includes("app_test_client"), false);
    assert.deepEqual(listStoredSecrets(dir), [SecretName.CODEX_CLIENT_ID]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("secrets prefer env over encrypted vault", () => {
  const dir = mkdtempSync(join(tmpdir(), "sub-bridge-secrets-"));
  try {
    saveSecret(dir, SecretName.BRIDGE_KEY, "vault-key");
    process.env.SUB_BRIDGE_TEST_BRIDGE_KEY = "env-key";
    const resolved = resolveSecret(dir, SecretName.BRIDGE_KEY, ["SUB_BRIDGE_TEST_BRIDGE_KEY"]);
    assert.equal(resolved.value, "env-key");
    assert.equal(resolved.source, "env");
  } finally {
    delete process.env.SUB_BRIDGE_TEST_BRIDGE_KEY;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy cursor token.enc remains readable", () => {
  const dir = mkdtempSync(join(tmpdir(), "sub-bridge-secrets-"));
  try {
    saveSecret(dir, SecretName.CURSOR_AUTH_TOKEN, "cursor-secret");
    assert.equal(
      resolveSecret(dir, SecretName.CURSOR_AUTH_TOKEN, ["SUB_BRIDGE_CURSOR_AUTH_TOKEN"]).value,
      "cursor-secret",
    );
    assert.equal(existsSync(join(dir, "token.enc")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
