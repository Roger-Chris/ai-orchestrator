import { defineConfig } from "vitest/config";

// tests/wake.test.ts imports mobile/src/lib/wakephrase.ts. Without this Vite reads mobile/tsconfig.json for it,
// which extends expo/tsconfig.base, so the hub's tests failed whenever mobile/node_modules was not installed.
export default defineConfig({ tsconfig: "tsconfig.json" });
