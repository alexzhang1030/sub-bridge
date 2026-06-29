import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { cli: "src/main.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
