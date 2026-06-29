import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { responsesBodyToCursorPrompt, runCursorAcpTurn } from "../src/cursor-acp.js";
import {
  cursorOptionsFromModelEntry,
  filterCursorModelsByGroups,
  mergeCursorModelVariantsWithBaseControls,
  normalizeCursorModelVariantBaseId,
  summarizeCursorModelGroups,
} from "../src/cursor-models.js";
import {
  defaultProviderId,
  defaultProviderName,
  defaultProviderPort,
  defaultProviderTypeForSub,
  providerPluginForType,
} from "../src/provider-plugins.js";
import { isAbortLikeError, isRetryableTransientError } from "../src/errors.js";

const root = new URL("..", import.meta.url).pathname;
const cli = join(root, "src", "cli.js");
const testConfig = join(root, `.tmp-config-${process.pid}.json`);

function run(args, env = {}) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: root,
    env: {
      ...process.env,
      SUB_BRIDGE_CONFIG: testConfig,
      ...env,
    },
    encoding: "utf8",
  });
}

function createMockCursorAgent({ failMemoryAuth = false, availableModels = true, cliModels = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sub-bridge-cursor-agent-"));
  const command = join(dir, "agent.mjs");
  writeFileSync(command, `#!/usr/bin/env node
import readline from "node:readline";
import { appendFileSync } from "node:fs";

const failMemoryAuth = ${JSON.stringify(failMemoryAuth)};
const availableModels = ${JSON.stringify(availableModels)};
const cliModels = ${JSON.stringify(cliModels)};
const args = process.argv.slice(2);
if (args.includes("models")) {
  if (process.env.MOCK_CLI_ARGS_PATH) {
    appendFileSync(process.env.MOCK_CLI_ARGS_PATH, JSON.stringify(args) + "\\n");
  }
  if (cliModels.length === 0) process.exit(2);
  process.stdout.write(cliModels.join("\\n") + "\\n");
  process.exit(0);
}
if (!args.includes("acp")) process.exit(2);

const modelConfigOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    options: [
      { value: "cursor-fast", name: "Cursor Fast" },
      { options: [
        { value: "cursor-deep", name: "Cursor Deep" },
        { value: "claude-haiku-4-5[thinking=false,context=200k,effort=high,fast=false]", name: "Haiku 4.5" }
      ] }
    ]
  },
  {
    id: "effort",
    name: "Effort",
    category: "model_option",
    type: "select",
    currentValue: "high",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      { value: "extra-high", name: "Extra High" }
    ]
  },
  {
    id: "context",
    name: "Context Window",
    category: "model_config",
    type: "select",
    currentValue: "200k",
    options: [
      { value: "200k", name: "200K" },
      { value: "1m", name: "1M" }
    ]
  },
  {
    id: "fast",
    name: "Fast Mode",
    category: "model_config",
    type: "boolean",
    currentValue: false
  },
  {
    id: "thinking",
    name: "Thinking",
    category: "model_config",
    type: "boolean",
    currentValue: false
  }
];

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n");
    return;
  }
  if (request.method === "authenticate") {
    if (failMemoryAuth && process.env.AGENT_CLI_CREDENTIAL_STORE === "memory") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message: "local auth unavailable" }
      }) + "\\n");
      return;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n");
    return;
  }
  if (request.method === "session/new") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        sessionId: "mock-session",
        configOptions: modelConfigOptions
      }
    }) + "\\n");
    return;
  }
  if (request.method === "cursor/list_available_models") {
    if (!availableModels) {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n");
      return;
    }
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        models: [
          {
            value: "gpt-5.5",
            name: "GPT-5.5",
            configOptions: [
              {
                id: "reasoning",
                name: "Reasoning",
                category: "model_option",
                type: "select",
                currentValue: "medium",
                options: [
                  { value: "low", name: "Low" },
                  { value: "medium", name: "Medium" },
                  { value: "high", name: "High" }
                ]
              },
              {
                id: "context",
                name: "Context Window",
                category: "model_config",
                type: "select",
                currentValue: "272k",
                options: [
                  { value: "272k", name: "272K" },
                  { value: "1m", name: "1M" }
                ]
              }
            ]
          },
          {
            value: "claude-haiku-4-5",
            name: "Haiku 4.5",
            configOptions: modelConfigOptions.slice(1)
          }
        ]
      }
    }) + "\\n");
    return;
  }
  if (request.method === "session/set_config_option") {
    if (process.env.MOCK_CAPTURE_PATH) {
      appendFileSync(process.env.MOCK_CAPTURE_PATH, JSON.stringify(request.params) + "\\n");
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n");
    return;
  }
  if (request.method === "session/prompt") {
    if (process.env.MOCK_CURSOR_EVENTS === "1") {
      const notify = (update) => process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "mock-session", update }
      }) + "\\n");
      notify({
        sessionUpdate: "agent_thought_chunk",
        messageId: "thought-1",
        content: { type: "text", text: "checking workspace" }
      });
      notify({
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Terminal",
        kind: "execute",
        status: "pending",
        rawInput: { executable: "echo", args: ["pong"] }
      });
      notify({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        kind: "execute",
        status: "completed",
        rawOutput: { exitCode: 0 }
      });
      notify({
        sessionUpdate: "agent_message_chunk",
        messageId: "answer-1",
        content: { type: "text", text: "pong" }
      });
    }
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n");
});
`, { mode: 0o755 });
  chmodSync(command, 0o755);
  return { command, dir };
}

async function waitForUrl(url, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function parseSseTypes(text) {
  const types = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") continue;
    const event = JSON.parse(payload);
    if (event?.type) types.push(event.type);
  }
  return types;
}

test("provider plugins resolve defaults for cursor, codex, and custom subscriptions", () => {
  assert.equal(defaultProviderTypeForSub("cursor"), "cursor-acp");
  assert.equal(defaultProviderTypeForSub("codex"), "codex");
  assert.equal(providerPluginForType("cursor").id, "cursor-acp");
  assert.equal(providerPluginForType("cursor-acp").id, "cursor-acp");
  assert.equal(providerPluginForType("codex").id, "codex");

  assert.equal(defaultProviderPort("cursor", "cursor-acp"), 17876);
  assert.equal(defaultProviderPort("codex", "codex"), 17877);
  assert.equal(defaultProviderId("team-sub", "custom"), "subbridge-team-sub");
  assert.equal(defaultProviderName("team-sub", "custom"), "SubBridge Team Sub");
});

test("prints help with project command names", () => {
  const output = run(["--help"]);
  assert.match(output, /sub-bridge --sub <name> status/);
  assert.match(output, /sub-bridge status/);
  assert.match(output, /sub-bridge doctor/);
  assert.match(output, /sub-bridge enable/);
  assert.match(output, /sub-bridge config show/);
  assert.match(output, /sub-bridge config group only <group\.\.\.>/);
  assert.match(output, /sub-bridge config group preset <latest\|off>/);
  assert.match(output, /sub-bridge install copilot/);
});

test("shows clean root config and sub effective config", () => {
  const output = JSON.parse(run(["config", "show"]));
  assert.equal(output.configPath, testConfig);
  assert.deepEqual(Object.keys(output.file), ["$schema", "version", "subscriptions"]);
  assert.equal(output.effective, null);

  const sub = JSON.parse(run(["--sub", "codex", "config", "show"]));
  assert.equal(sub.effective.host, "127.0.0.1");
  assert.equal(sub.effective.type, "codex");
  assert.equal(sub.effective.defaultModel, "gpt-5.5");
});

test("sets subscription config values in the config file", () => {
  rmSync(testConfig, { force: true });
  assert.match(run(["--sub", "codex", "config", "set", "providerName", "SubBridge Test"]), /set providerName/);
  const output = JSON.parse(run(["--sub", "codex", "config", "show"]));
  assert.equal(output.file.subscriptions.codex.providerName, "SubBridge Test");
  assert.equal(output.effective.providerName, "SubBridge Test");
});

test("stores subscription config separately with clean root keys", () => {
  rmSync(testConfig, { force: true });
  assert.match(run(["--sub", "cursor", "config", "set", "type", "cursor-acp"]), /set type/);
  assert.match(run(["--sub", "codex", "config", "set", "type", "codex"]), /set type/);

  const cursor = JSON.parse(run(["--sub", "cursor", "config", "show"]));
  const rootConfig = JSON.parse(run(["config", "show"]));
  assert.equal(cursor.subscription, "cursor");
  assert.deepEqual(Object.keys(rootConfig.file), ["$schema", "version", "subscriptions"]);
  assert.deepEqual(Object.keys(cursor.file.subscriptions.cursor), [
    "type",
    "host",
    "port",
    "models",
    "providerId",
    "providerName",
  ]);
  assert.equal(cursor.file.subscriptions.cursor.type, "cursor-acp");
  assert.equal(cursor.effective.subscription, "cursor");
  assert.equal(cursor.effective.type, "cursor-acp");
  assert.equal(cursor.effective.providerId, "codexsub-openai-codex");
  assert.equal(rootConfig.file.subscriptions.codex.type, "codex");
});

test("subscription init stores subscription metadata and models", () => {
  rmSync(testConfig, { force: true });
  assert.match(run(["--sub", "cursor", "config", "set", "type", "cursor-acp"]), /set type/);
  assert.match(run(["--sub", "cursor", "config", "init"], {
    SUB_BRIDGE_CURSOR_ACP_COMMAND: "__missing_cursor_agent__",
  }), /wrote/);

  const cursor = JSON.parse(run(["--sub", "cursor", "config", "show"]));
  assert.equal(cursor.file.subscriptions.cursor.type, "cursor-acp");
  assert.deepEqual(Object.keys(cursor.file.subscriptions.cursor), [
    "type",
    "host",
    "port",
    "models",
    "providerId",
    "providerName",
  ]);
  assert.ok(Array.isArray(cursor.file.subscriptions.cursor.models));
  assert.ok(cursor.file.subscriptions.cursor.models.some((model) => model.id === "gpt-5.5"));
  assert.equal(cursor.effective.defaultModel, "gpt-5.5");
});

test("offline cursor config init uses builtin models without spawning provider commands", () => {
  rmSync(testConfig, { force: true });
  const dir = mkdtempSync(join(tmpdir(), "sub-bridge-offline-agent-"));
  const command = join(dir, "agent.mjs");
  const invokedPath = join(dir, "invoked");
  writeFileSync(command, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(invokedPath)}, process.argv.slice(2).join(" "));
process.exit(9);
`, { mode: 0o755 });
  chmodSync(command, 0o755);

  try {
    assert.match(run(["--sub", "cursor", "config", "set", "type", "cursor-acp"]), /set type/);
    assert.match(run(["--sub", "cursor", "config", "init"], {
      SUB_BRIDGE_OFFLINE: "1",
      SUB_BRIDGE_CURSOR_ACP_COMMAND: command,
    }), /wrote/);

    const cursor = JSON.parse(run(["--sub", "cursor", "config", "show"]));
    assert.ok(cursor.file.subscriptions.cursor.models.some((model) => model.id === "gpt-5.5"));
    assert.equal(existsSync(invokedPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("offline codex config init uses builtin models through provider plugin", () => {
  rmSync(testConfig, { force: true });
  assert.match(run(["--sub", "codex", "config", "set", "type", "codex"]), /set type/);
  assert.match(run(["--sub", "codex", "config", "init"], {
    SUB_BRIDGE_OFFLINE: "1",
    SUB_BRIDGE_PI_DIR: join(root, `.tmp-missing-pi-${process.pid}`),
  }), /wrote/);

  const codex = JSON.parse(run(["--sub", "codex", "config", "show"]));
  assert.equal(codex.file.subscriptions.codex.type, "codex");
  assert.ok(codex.file.subscriptions.codex.models.some((model) => model.id === "gpt-5.5"));
});

test("cursor init fetches models from ACP available models", () => {
  rmSync(testConfig, { force: true });
  const mock = createMockCursorAgent();
  try {
    assert.match(run(["--sub", "cursor", "config", "set", "type", "cursor-acp"]), /set type/);
    assert.match(run(["--sub", "cursor", "config", "set", "models", JSON.stringify([
      {
        id: "claude-haiku-4-5",
        displayName: "Haiku 4.5",
        contextWindow: 128000,
        maxTokens: 128000,
        fastMode: false,
        thinking: true,
        cursorContextWindow: "1m",
      },
    ])]), /set models/);
    assert.match(run(["--sub", "cursor", "config", "init"], {
      SUB_BRIDGE_CURSOR_ACP_COMMAND: mock.command,
    }), /wrote/);

    const cursor = JSON.parse(run(["--sub", "cursor", "config", "show"]));
    assert.deepEqual(cursor.file.subscriptions.cursor.models.map((model) => model.id), [
      "gpt-5.5",
      "claude-haiku-4-5",
    ]);
    const claude = cursor.file.subscriptions.cursor.models.find((model) => model.id === "claude-haiku-4-5");
    assert.equal(claude.fastMode, false);
    assert.equal(claude.thinking, true);
    assert.equal(claude.cursorContextWindow, "1m");
    assert.equal(claude.supportsFastMode, true);
    assert.equal(claude.supportsThinking, true);
  } finally {
    rmSync(mock.dir, { recursive: true, force: true });
  }
});

test("cursor init merges ACP model metadata with CLI-only models", () => {
  rmSync(testConfig, { force: true });
  const mock = createMockCursorAgent({
    cliModels: [
      "gpt-5.5 - GPT-5.5 CLI",
      "cursor-cli-only - Cursor CLI Only",
    ],
  });
  const cliArgsPath = join(mock.dir, "cli-args.jsonl");
  try {
    assert.match(run(["--sub", "cursor", "config", "set", "type", "cursor-acp"]), /set type/);
    assert.match(run(["--sub", "cursor", "config", "init"], {
      MOCK_CLI_ARGS_PATH: cliArgsPath,
      SUB_BRIDGE_CURSOR_ACP_COMMAND: mock.command,
      SUB_BRIDGE_CURSOR_API_ENDPOINT: "https://cursor.example.test",
    }), /wrote/);

    const cursor = JSON.parse(run(["--sub", "cursor", "config", "show"]));
    assert.deepEqual(cursor.file.subscriptions.cursor.models.map((model) => model.id), [
      "gpt-5.5",
      "claude-haiku-4-5",
      "cursor-cli-only",
    ]);
    const gpt = cursor.file.subscriptions.cursor.models.find((model) => model.id === "gpt-5.5");
    assert.equal(gpt.displayName, "GPT-5.5");
    assert.equal(gpt.contextWindow, 272000);
    assert.equal(gpt.defaultContextWindow, "272k");
    assert.equal(gpt.defaultReasoningEffort, "medium");
    assert.deepEqual(gpt.supportedReasoningEfforts.map((entry) => entry.value), ["low", "medium", "high"]);
    const cliOnly = cursor.file.subscriptions.cursor.models.find((model) => model.id === "cursor-cli-only");
    assert.equal(cliOnly.displayName, "Cursor CLI Only");

    const cliArgs = readFileSync(cliArgsPath, "utf8")
      .trim()
      .split(/\n/)
      .map((line) => JSON.parse(line));
    assert.deepEqual(cliArgs.at(-1), ["-e", "https://cursor.example.test", "models"]);
  } finally {
    rmSync(mock.dir, { recursive: true, force: true });
  }
});

test("cursor model groups enable and disable expanded model families", () => {
  rmSync(testConfig, { force: true });
  const mock = createMockCursorAgent();
  try {
    assert.match(run(["--sub", "cursor", "config", "set", "type", "cursor-acp"]), /set type/);
    assert.match(run(["--sub", "cursor", "config", "init"], {
      SUB_BRIDGE_CURSOR_ACP_COMMAND: mock.command,
    }), /wrote/);

    const before = JSON.parse(run(["--sub", "cursor", "models"]));
    assert.ok(before.data.some((model) => model.id.startsWith("claude-haiku-4-5")));
    assert.ok(before.data.some((model) => model.id.includes("[context=1m,effort=high,fast=true,thinking=true]")));

    const groups = JSON.parse(run(["--sub", "cursor", "config", "groups"]));
    assert.equal(groups.find((group) => group.id === "provider:anthropic")?.enabled, true);
    assert.ok(groups.find((group) => group.id === "family:claude-haiku-4-5")?.modelCount > 1);

    assert.match(run(["--sub", "cursor", "config", "group", "disable", "anthropic"]), /disabled model group provider:anthropic/);
    const disabled = JSON.parse(run(["--sub", "cursor", "models"]));
    assert.equal(disabled.data.some((model) => model.id.startsWith("claude-haiku-4-5")), false);
    assert.ok(disabled.data.some((model) => model.id.startsWith("gpt-5.5")));

    const disabledGroups = JSON.parse(run(["--sub", "cursor", "config", "groups"]));
    assert.equal(disabledGroups.find((group) => group.id === "provider:anthropic")?.enabled, false);

    assert.match(run(["--sub", "cursor", "config", "group", "enable", "provider:anthropic"]), /enabled model group provider:anthropic/);
    const enabled = JSON.parse(run(["--sub", "cursor", "models"]));
    assert.ok(enabled.data.some((model) => model.id.startsWith("claude-haiku-4-5")));

    assert.match(run(["--sub", "cursor", "config", "group", "only", "gpt-5.5"]), /selected model groups family:gpt-5.5/);
    const onlyGpt = JSON.parse(run(["--sub", "cursor", "models"]));
    assert.ok(onlyGpt.data.some((model) => model.id.startsWith("gpt-5.5")));
    assert.equal(onlyGpt.data.some((model) => model.id.startsWith("claude-haiku-4-5")), false);

    const onlyGroups = JSON.parse(run(["--sub", "cursor", "config", "groups"]));
    assert.equal(onlyGroups.find((group) => group.id === "family:gpt-5.5")?.enabled, true);
    assert.equal(onlyGroups.find((group) => group.id === "family:claude-haiku-4-5")?.enabled, false);

    assert.match(run(["--sub", "cursor", "config", "group", "enable", "claude-haiku-4-5"]), /enabled model group family:claude-haiku-4-5/);
    const withHaiku = JSON.parse(run(["--sub", "cursor", "models"]));
    assert.ok(withHaiku.data.some((model) => model.id.startsWith("claude-haiku-4-5")));

    assert.match(run(["--sub", "cursor", "config", "group", "disable", "claude-haiku-4-5"]), /disabled model group family:claude-haiku-4-5/);
    const withoutHaiku = JSON.parse(run(["--sub", "cursor", "models"]));
    assert.equal(withoutHaiku.data.some((model) => model.id.startsWith("claude-haiku-4-5")), false);

    assert.match(run(["--sub", "cursor", "config", "group", "reset"]), /reset model groups/);
    const reset = JSON.parse(run(["--sub", "cursor", "models"]));
    assert.ok(reset.data.some((model) => model.id.startsWith("claude-haiku-4-5")));

    assert.match(run(["--sub", "cursor", "config", "group", "only", "provider:anthropic"]), /selected model groups provider:anthropic/);
    const onlyAnthropic = JSON.parse(run(["--sub", "cursor", "models"]));
    assert.ok(onlyAnthropic.data.some((model) => model.id.startsWith("claude-haiku-4-5")));
    assert.equal(onlyAnthropic.data.some((model) => model.id.startsWith("gpt-5.5")), false);

    assert.match(run(["--sub", "cursor", "config", "group", "disable", "claude-haiku-4-5"]), /disabled model group family:claude-haiku-4-5/);
    const providerWithFamilyExcluded = JSON.parse(run(["--sub", "cursor", "models"]));
    assert.equal(providerWithFamilyExcluded.data.some((model) => model.id.startsWith("claude-haiku-4-5")), false);

    assert.match(run(["--sub", "cursor", "config", "group", "preset", "latest"]), /set model group preset latest/);
    assert.equal(JSON.parse(run(["--sub", "cursor", "config", "get", "modelGroups"])).preset, "latest");

    assert.match(run(["--sub", "cursor", "config", "group", "preset", "off"]), /set model group preset off/);
    assert.equal(JSON.parse(run(["--sub", "cursor", "config", "get", "modelGroups"])).preset, "");
  } finally {
    rmSync(mock.dir, { recursive: true, force: true });
  }
});

test("cursor init falls back to agent auth for model discovery", () => {
  rmSync(testConfig, { force: true });
  const mock = createMockCursorAgent({ failMemoryAuth: true });
  try {
    assert.match(run(["--sub", "cursor", "config", "set", "type", "cursor-acp"]), /set type/);
    assert.match(run(["--sub", "cursor", "config", "init"], {
      SUB_BRIDGE_CURSOR_ACP_COMMAND: mock.command,
    }), /wrote/);

    const cursor = JSON.parse(run(["--sub", "cursor", "config", "show"]));
    assert.deepEqual(cursor.file.subscriptions.cursor.models.map((model) => model.id), [
      "gpt-5.5",
      "claude-haiku-4-5",
    ]);
  } finally {
    rmSync(mock.dir, { recursive: true, force: true });
  }
});

test("cursor init falls back to ACP session config options", () => {
  rmSync(testConfig, { force: true });
  const mock = createMockCursorAgent({ availableModels: false });
  try {
    assert.match(run(["--sub", "cursor", "config", "set", "type", "cursor-acp"]), /set type/);
    assert.match(run(["--sub", "cursor", "config", "init"], {
      SUB_BRIDGE_CURSOR_ACP_COMMAND: mock.command,
    }), /wrote/);

    const cursor = JSON.parse(run(["--sub", "cursor", "config", "show"]));
    assert.deepEqual(cursor.file.subscriptions.cursor.models.map((model) => model.id), [
      "cursor-fast",
      "cursor-deep",
      "claude-haiku-4-5[thinking=false,context=200k,effort=high,fast=false]",
    ]);
  } finally {
    rmSync(mock.dir, { recursive: true, force: true });
  }
});

test("cursor ACP sets requested model and per-model options", async () => {
  const mock = createMockCursorAgent();
  const capturePath = join(mock.dir, "capture.jsonl");
  try {
    await runCursorAcpTurn({
      command: mock.command,
      workspace: root,
      env: {
        ...process.env,
        MOCK_CAPTURE_PATH: capturePath,
      },
      timeoutMs: 5000,
      model: "claude-haiku-4-5",
      modelOptions: {
        reasoningEffort: "high",
        fastMode: false,
        thinking: true,
        contextWindow: "1m",
      },
      body: {
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "Say pong." }],
          },
        ],
      },
    });

    const writes = readFileSync(capturePath, "utf8")
      .trim()
      .split(/\n/)
      .map((line) => JSON.parse(line));
    assert.ok(writes.some((entry) =>
      entry.configId === "model" &&
      entry.value === "claude-haiku-4-5[thinking=true,context=1m,effort=high,fast=false]",
    ));
    assert.ok(writes.some((entry) => entry.configId === "effort" && entry.value === "high"));
    assert.ok(writes.some((entry) => entry.configId === "context" && entry.value === "1m"));
    assert.ok(writes.some((entry) => entry.configId === "fast" && entry.value === false));
    assert.ok(writes.some((entry) => entry.configId === "thinking" && entry.value === true));
  } finally {
    rmSync(mock.dir, { recursive: true, force: true });
  }
});

test("cursor model options preserve legacy off as fast mode off", () => {
  assert.deepEqual(cursorOptionsFromModelEntry({
    id: "claude-haiku-4-5",
    displayName: "Haiku 4.5",
    contextWindow: 128000,
    maxTokens: 128000,
    reasoningEffort: "off",
  }), {
    fastMode: false,
  });
});

test("cursor model variants follow Synara base plus raw variant shape", () => {
  assert.equal(normalizeCursorModelVariantBaseId("claude-opus-4-8-thinking-max"), "claude-opus-4-8");
  assert.equal(normalizeCursorModelVariantBaseId("gpt-5.1-codex-max-medium-fast"), "gpt-5.1-codex-max");

  const composerModels = mergeCursorModelVariantsWithBaseControls([
    {
      id: "composer-2.5",
      displayName: "Composer 2.5",
      contextWindow: 128000,
      maxTokens: 128000,
      supportsFastMode: true,
    },
    {
      id: "composer-2.5-fast",
      displayName: "Composer 2.5 Fast",
      contextWindow: 128000,
      maxTokens: 128000,
      fastMode: true,
    },
  ]);
  assert.deepEqual(composerModels.map((model) => model.id), ["composer-2.5", "composer-2.5[fast=true]"]);
  assert.deepEqual(composerModels.map((model) => model.displayName), ["Composer 2.5", "Composer 2.5 Fast"]);

  const latestPresetModels = filterCursorModelsByGroups(mergeCursorModelVariantsWithBaseControls([
    {
      id: "claude-opus-4-8",
      displayName: "Opus 4.8",
      contextWindow: 1000000,
      maxTokens: 128000,
      upstreamProviderId: "anthropic",
      upstreamProviderName: "Anthropic",
      supportedReasoningEfforts: [{ value: "high", label: "High" }],
      defaultReasoningEffort: "high",
      supportsFastMode: true,
      supportsThinking: true,
      contextWindowOptions: [{ value: "1m", label: "1M", isDefault: true }],
      defaultContextWindow: "1m",
    },
    {
      id: "gpt-5.5",
      displayName: "GPT-5.5",
      contextWindow: 1000000,
      maxTokens: 128000,
      upstreamProviderId: "openai",
      upstreamProviderName: "OpenAI",
      supportedReasoningEfforts: [{ value: "medium", label: "Medium" }],
      defaultReasoningEffort: "medium",
      supportsFastMode: true,
      contextWindowOptions: [{ value: "1m", label: "1M", isDefault: true }],
      defaultContextWindow: "1m",
    },
    {
      id: "composer-2.5",
      displayName: "Composer 2.5",
      contextWindow: 128000,
      maxTokens: 128000,
      supportsFastMode: true,
    },
    {
      id: "glm-5.2",
      displayName: "GLM 5.2",
      contextWindow: 128000,
      maxTokens: 128000,
    },
  ]), { preset: "latest" });
  assert.deepEqual(latestPresetModels.map((model) => model.displayName), [
    "Opus 4.8",
    "Opus 4.8 Fast",
    "Opus 4.8 Thinking",
    "Opus 4.8 Thinking Fast",
    "GPT-5.5",
    "GPT-5.5 Fast",
    "Composer 2.5",
    "Composer 2.5 Fast",
    "GLM 5.2",
  ]);
  assert.deepEqual(latestPresetModels.map((model) => model.id), [
    "claude-opus-4-8[context=1m,effort=high]",
    "claude-opus-4-8[context=1m,effort=high,fast=true]",
    "claude-opus-4-8[context=1m,effort=high,thinking=true]",
    "claude-opus-4-8[context=1m,effort=high,fast=true,thinking=true]",
    "gpt-5.5[context=1m,effort=medium]",
    "gpt-5.5[context=1m,effort=medium,fast=true]",
    "composer-2.5",
    "composer-2.5[fast=true]",
    "glm-5.2",
  ]);

  const models = mergeCursorModelVariantsWithBaseControls([
    {
      id: "claude-opus-4-8",
      displayName: "Opus 4.8",
      contextWindow: 300000,
      maxTokens: 128000,
      upstreamProviderId: "anthropic",
      upstreamProviderName: "Anthropic",
      supportedReasoningEfforts: [
        { value: "low", label: "Low" },
        { value: "xhigh", label: "Extra High" },
      ],
      defaultReasoningEffort: "xhigh",
      supportsFastMode: true,
      contextWindowOptions: [
        { value: "300k", label: "300K", isDefault: true },
        { value: "1m", label: "1M" },
      ],
      defaultContextWindow: "300k",
    },
  ]);

  assert.deepEqual(models.slice(0, 4).map((model) => model.id), [
    "claude-opus-4-8",
    "claude-opus-4-8[context=300k,effort=low]",
    "claude-opus-4-8[context=300k,effort=low,fast=true]",
    "claude-opus-4-8[context=300k,effort=extra-high]",
  ]);
  assert.ok(models.some((model) =>
    model.id === "claude-opus-4-8[context=1m,effort=extra-high,fast=true]" &&
    model.displayName === "Opus 4.8 1M Extra High Fast",
  ));

  const groups = summarizeCursorModelGroups(models, { disabled: ["family:claude-opus-4-8"] });
  assert.equal(groups.find((group) => group.id === "provider:anthropic")?.modelCount, models.length);
  assert.equal(groups.find((group) => group.id === "family:claude-opus-4-8")?.enabled, false);
  assert.deepEqual(filterCursorModelsByGroups(models, { disabled: ["provider:anthropic"] }), []);
  assert.deepEqual(filterCursorModelsByGroups(models, { only: ["family:claude-opus-4-8"] }), models);
  assert.deepEqual(filterCursorModelsByGroups(models, { only: ["provider:openai"] }), []);

  const ordered = filterCursorModelsByGroups([
    {
      id: "composer-2.5",
      displayName: "Composer 2.5",
      contextWindow: 128000,
      maxTokens: 128000,
    },
    {
      id: "claude-opus-4-8",
      displayName: "Opus 4.8",
      contextWindow: 300000,
      maxTokens: 128000,
      upstreamProviderId: "anthropic",
      upstreamProviderName: "Anthropic",
    },
  ], { only: ["family:claude-opus-4-8", "family:composer-2.5"] });
  assert.deepEqual(ordered.map((model) => model.id), ["claude-opus-4-8", "composer-2.5"]);

  const onlyGroups = summarizeCursorModelGroups(models, { only: ["family:claude-opus-4-8"] });
  assert.equal(onlyGroups.find((group) => group.id === "family:claude-opus-4-8")?.activeModelCount, models.length);
  assert.equal(onlyGroups.find((group) => group.id === "provider:anthropic")?.activeModelCount, models.length);
});

test("cursor ACP surfaces reasoning, tool calls, and assistant events", async () => {
  const mock = createMockCursorAgent();
  try {
    const result = await runCursorAcpTurn({
      command: mock.command,
      workspace: root,
      env: {
        ...process.env,
        MOCK_CURSOR_EVENTS: "1",
      },
      timeoutMs: 5000,
      model: "gpt-5.5",
      body: {
        input: "Say pong.",
      },
    });

    assert.equal(result.text, "pong");
    assert.deepEqual(result.events.map((event) => event.type), [
      "content_delta",
      "tool_call",
      "tool_call",
      "content_delta",
    ]);
    assert.equal(result.events[0].streamKind, "reasoning_text");
    assert.equal(result.events[1].toolCall.kind, "execute");
    assert.equal(result.events[2].toolCall.status, "completed");
    assert.equal(result.events[3].streamKind, "assistant_text");
  } finally {
    rmSync(mock.dir, { recursive: true, force: true });
  }
});

test("cursor bridge streams reasoning and assistant Responses events", async () => {
  rmSync(testConfig, { force: true });
  const mock = createMockCursorAgent();
  const port = String(25000 + (process.pid % 10000));
  let child = null;
  try {
    assert.match(run(["--sub", "cursor-sse", "config", "set", "type", "cursor-acp"]), /set type/);
    assert.match(run(["--sub", "cursor-sse", "config", "set", "port", port]), /set port/);
    assert.match(run(["--sub", "cursor-sse", "config", "set", "models", JSON.stringify([
      { id: "gpt-5.5", displayName: "GPT-5.5", contextWindow: 128000, maxTokens: 128000 },
    ])]), /set models/);

    child = spawn(process.execPath, [cli, "--sub", "cursor-sse", "serve"], {
      cwd: root,
      env: {
        ...process.env,
        SUB_BRIDGE_CONFIG: testConfig,
        SUB_BRIDGE_CURSOR_ACP_COMMAND: mock.command,
        MOCK_CURSOR_EVENTS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    await waitForUrl(`http://127.0.0.1:${port}/v1/models`);
    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        stream: true,
        input: "Say pong.",
      }),
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    const types = parseSseTypes(text);
    assert.ok(types.includes("response.reasoning_summary_text.delta"));
    assert.ok(types.includes("response.output_item.added"));
    assert.ok(types.includes("response.function_call_arguments.delta"));
    assert.ok(types.includes("response.function_call_arguments.done"));
    assert.ok(types.includes("response.output_text.delta"));
    assert.ok(types.includes("response.completed"));
    assert.ok(text.includes('"name":"subbridge_cursor_execute"'));
    assert.ok(text.includes('\\"command\\":\\"echo pong\\"'));
    assert.equal(text.includes('"name":"cursor_tool"'), false);
  } finally {
    if (child && !child.killed) child.kill("SIGTERM");
    rmSync(mock.dir, { recursive: true, force: true });
  }
});

test("classifies cancellation and retryable transport errors", () => {
  assert.equal(isAbortLikeError(new Error("T: [canceled] http/2 stream closed with error code CANCEL (0x8)")), true);
  assert.equal(isAbortLikeError(Object.assign(new Error("Request was aborted"), { name: "AbortError" })), true);
  assert.equal(isRetryableTransientError(new Error("fetch failed")), true);
  assert.equal(isRetryableTransientError(new Error("T: [canceled] http/2 stream closed with error code CANCEL (0x8)")), false);
});

test("lists provider targets", () => {
  const targets = JSON.parse(run(["targets"]));
  assert.deepEqual(targets, [
    { id: "copilot", name: "GitHub Copilot", status: "supported" },
    { id: "cursor", name: "Cursor", status: "planned" },
  ]);
});

test("install copilot writes provider rows and SubBridge cursor tools extension", () => {
  try {
    execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
  } catch {
    return;
  }

  rmSync(testConfig, { force: true });
  const dir = mkdtempSync(join(tmpdir(), "sub-bridge-copilot-install-"));
  const dbPath = join(dir, "data.db");
  const extensionDir = join(dir, "extensions", "sub-bridge-tools");
  try {
    execFileSync("sqlite3", [dbPath, `
create table model_providers (
  id text primary key,
  name text,
  base_url text,
  wire_api text,
  azure_api_version text,
  auth_kind text,
  headers_json text,
  type text,
  settings_json text,
  updated_at text
);
create table provider_models (
  id text primary key,
  provider_id text,
  model_id text,
  wire_model text,
  display_name text,
  max_prompt_tokens integer,
  max_output_tokens integer,
  wire_api_override text,
  updated_at text
);
`]);
    assert.match(run(["--sub", "cursor", "config", "set", "type", "cursor-acp"]), /set type/);
    const output = run(["--sub", "cursor", "install", "copilot"], {
      SUB_BRIDGE_COPILOT_DB: dbPath,
      SUB_BRIDGE_COPILOT_EXTENSION_DIR: extensionDir,
    });
    assert.match(output, /installed provider SubBridge/);
    const extension = readFileSync(join(extensionDir, "extension.mjs"), "utf8");
    assert.ok(extension.includes('"execute"'));
    assert.ok(extension.includes('"subbridge_cursor_" + kind'));
    assert.ok(extension.includes("joinSession"));
    const count = execFileSync("sqlite3", [dbPath, "select count(*) from provider_models where provider_id='codexsub-openai-codex';"], { encoding: "utf8" }).trim();
    assert.notEqual(count, "0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lists bridge models", () => {
  const models = JSON.parse(run(["models"]));
  assert.equal(models.object, "list");
  assert.ok(models.data.some((model) => model.id === "gpt-5.5"));
});

test("uses configured subscription model list", () => {
  rmSync(testConfig, { force: true });
  const configuredModels = JSON.stringify([
    { id: "custom-model", displayName: "Custom Model", contextWindow: 1000, maxTokens: 500 },
  ]);
  assert.match(run(["--sub", "codex", "config", "set", "models", configuredModels]), /set models/);
  const models = JSON.parse(run(["--sub", "codex", "models"]));
  assert.deepEqual(models.data, [
    {
      id: "custom-model",
      object: "model",
      created: 0,
      owned_by: "openai-codex",
    },
  ]);
});

test("enable starts subscription service", () => {
  rmSync(testConfig, { force: true });
  const port = String(21000 + (process.pid % 10000));
  const stateDir = join(root, `.tmp-enable-state-${process.pid}`);
  const runtimeEnv = { SUB_BRIDGE_CODEX_ENABLE_STATE_DIR: stateDir };

  try {
    assert.match(run(["--sub", "codex-enable", "config", "set", "port", port]), /set port/);
    const output = run(["--sub", "codex-enable", "enable"], runtimeEnv);
    assert.match(output, /started pid=/);
    assert.match(output, /enabled subscription=codex-enable/);

    const config = JSON.parse(run(["--sub", "codex-enable", "config", "show"]));
    assert.deepEqual(Object.keys(config.file.subscriptions["codex-enable"]), [
      "type",
      "host",
      "port",
      "models",
      "providerId",
      "providerName",
    ]);
  } finally {
    run(["--sub", "codex-enable", "stop"], runtimeEnv);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("start without sub starts all subscriptions", () => {
  rmSync(testConfig, { force: true });
  const stateA = join(root, `.tmp-all-state-a-${process.pid}`);
  const stateB = join(root, `.tmp-all-state-b-${process.pid}`);
  const portA = String(22000 + (process.pid % 10000));
  const portB = String(23000 + (process.pid % 10000));
  const runtimeEnv = {
    SUB_BRIDGE_ALPHA_STATE_DIR: stateA,
    SUB_BRIDGE_BETA_STATE_DIR: stateB,
  };

  try {
    assert.match(run(["--sub", "alpha", "config", "set", "type", "codex"]), /set type/);
    assert.match(run(["--sub", "alpha", "config", "set", "port", portA]), /set port/);
    assert.match(run(["--sub", "beta", "config", "set", "type", "codex"]), /set type/);
    assert.match(run(["--sub", "beta", "config", "set", "port", portB]), /set port/);

    const output = run(["start"], runtimeEnv);
    assert.match(output, /started pid=/);
    const status = JSON.parse(run(["status"], runtimeEnv));
    assert.equal(status.subscriptions.alpha.running, true);
    assert.equal(status.subscriptions.beta.running, true);
  } finally {
    run(["stop"], runtimeEnv);
    rmSync(stateA, { recursive: true, force: true });
    rmSync(stateB, { recursive: true, force: true });
  }
});

test("cursor login stores encrypted local token", () => {
  rmSync(testConfig, { force: true });
  const authDir = join(root, `.tmp-cursor-auth-${process.pid}`);
  const stateDir = join(root, `.tmp-cursor-auth-state-${process.pid}`);
  const token = "cursor-test-token";
  const runtimeEnv = {
    SUB_BRIDGE_CURSOR_AUTH_DIR: authDir,
    SUB_BRIDGE_CURSOR_STATE_DIR: stateDir,
    SUB_BRIDGE_CURSOR_PORT: String(24000 + (process.pid % 10000)),
  };

  try {
    assert.match(run(["--sub", "cursor", "login"], {
      ...runtimeEnv,
      SUB_BRIDGE_CURSOR_AUTH_TOKEN: token,
    }), /stored cursor auth token/);
    const tokenPath = join(authDir, "token.enc");
    assert.equal(existsSync(tokenPath), true);
    assert.equal(readFileSync(tokenPath, "utf8").includes(token), false);
    const doctor = JSON.parse(run(["--sub", "cursor", "doctor"], {
      ...runtimeEnv,
      SUB_BRIDGE_CURSOR_ACP_COMMAND: "__missing_cursor_agent__",
    }));
    assert.equal(doctor.auth.cursor.local.tokenExists, true);
    run(["--sub", "cursor", "logout"], runtimeEnv);
    assert.equal(existsSync(tokenPath), false);
  } finally {
    rmSync(authDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("doctor reports local surfaces without token values", () => {
  const output = JSON.parse(run(["doctor"], {
    SUB_BRIDGE_PORT: "19076",
    SUB_BRIDGE_AUTH_PATH: join(root, `.tmp-auth-${process.pid}.json`),
    SUB_BRIDGE_COPILOT_DB: join(root, `.tmp-copilot-${process.pid}.db`),
    SUB_BRIDGE_CURSOR_ACP_COMMAND: "__missing_cursor_agent__",
  }));
  assert.equal(output.subscription, null);
  assert.equal(output.effective.baseUrl, "http://127.0.0.1:19076/v1");
  assert.equal(output.auth.codex.exists, false);
  assert.equal(output.auth.codex.accessTokenPresent, false);
  assert.equal(output.copilot.exists, false);
  assert.equal(output.tools.cursorAgent.checked, false);
  assert.equal(output.tools.cursorAgent.reason, "inactive-backend");
  assert.equal(JSON.stringify(output).includes("access_token"), false);
});

test("converts responses input to Cursor ACP prompt blocks", () => {
  const prompt = responsesBodyToCursorPrompt({
    instructions: "Be concise.",
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "Say pong." }],
      },
    ],
  });
  assert.deepEqual(prompt, [
    {
      type: "text",
      text: "Instructions:\nBe concise.\n\nuser:\nSay pong.",
    },
  ]);
});
