import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules/**", "npm/**", "git/**", "sessions/**"],
    testTimeout: 10_000,
  },
});
