import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  oxc: {
    jsx: {
      runtime: "automatic",
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@security": path.resolve(__dirname, "../bridge/src/security"),
      "@hpke/core": path.resolve(__dirname, "./node_modules/@hpke/core/esm/mod.js"),
      "@hpke/common": path.resolve(__dirname, "./node_modules/@hpke/common/esm/mod.js"),
      "zod": path.resolve(__dirname, "./node_modules/zod/index.js"),
      "commander": path.resolve(__dirname, "./node_modules/commander/esm.mjs"),
    },
  },
});
