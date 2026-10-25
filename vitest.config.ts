import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-10-25",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: { ROOMS: { className: "Room", useSQLite: true } },
        bindings: {
          REALTIME_SFU_APP_ID: "test-app",
          REALTIME_SFU_BEARER_TOKEN: "test-secret",
          TURN_KEY_ID: "test-turn-key",
          TURN_API_TOKEN: "test-turn-token",
        },
      },
    }),
  ],
  test: {
    include: ["tests/runtime/**/*.test.ts"],
    setupFiles: ["./tests/runtime/setup.ts"],
  },
});
