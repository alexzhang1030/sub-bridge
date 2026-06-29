import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const cli = join(root, "src", "cli.js");
const testConfig = join(root, ".tmp-config.json");

function run(args, env = {}) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: root,
    env: {
      ...process.env,
      SUB_BRIDGE_CONFIG: testConfig,
      SUB_BRIDGE_STATE_DIR: join(root, ".tmp-state"),
      ...env,
    },
    encoding: "utf8",
  });
}

test("prints help with project command names", () => {
  const output = run(["--help"]);
  assert.match(output, /sub-bridge status/);
  assert.match(output, /sub-bridge config show/);
  assert.match(output, /sub-bridge install copilot/);
});

test("shows config path and effective config", () => {
  const output = JSON.parse(run(["config", "show"]));
  assert.equal(output.configPath, testConfig);
  assert.equal(output.effective.host, "127.0.0.1");
  assert.equal(output.effective.reasoningEffort, "xhigh");
});

test("sets config values in the config file", () => {
  rmSync(testConfig, { force: true });
  assert.match(run(["config", "set", "reasoningEffort", "max"]), /set reasoningEffort/);
  const output = JSON.parse(run(["config", "show"]));
  assert.equal(output.file.reasoningEffort, "max");
  assert.equal(output.effective.reasoningEffort, "max");
});

test("lists provider targets", () => {
  const targets = JSON.parse(run(["targets"]));
  assert.deepEqual(targets, [
    { id: "copilot", name: "GitHub Copilot", status: "supported" },
    { id: "cursor", name: "Cursor", status: "planned" },
  ]);
});

test("lists bridge models", () => {
  const models = JSON.parse(run(["models"]));
  assert.equal(models.object, "list");
  assert.ok(models.data.some((model) => model.id === "gpt-5.5"));
});
