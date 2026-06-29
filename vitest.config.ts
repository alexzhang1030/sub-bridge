import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.{mjs,ts}"],
    fileParallelism: false,
    testTimeout: 60_000,
    env: {
      SUB_BRIDGE_CURSOR_ACP_POOL: "0",
      SUB_BRIDGE_OFFLINE: "0",
    },
  },
});
