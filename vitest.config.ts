import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@earendil-works/pi-coding-agent": "C:/Users/Fool/AppData/Local/pi-node/current/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
      "@earendil-works/pi-agent-core": "C:/Users/Fool/AppData/Local/pi-node/current/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/index.js",
      "@earendil-works/pi-ai": "C:/Users/Fool/AppData/Local/pi-node/current/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js",
      "@earendil-works/pi-tui": "C:/Users/Fool/AppData/Local/pi-node/current/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js",
      "typebox": "C:/Users/Fool/AppData/Local/pi-node/current/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox/build/index.mjs",
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules/**", "npm/**", "git/**", "sessions/**"],
    testTimeout: 10_000,
  },
});
