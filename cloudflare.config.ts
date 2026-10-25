import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "piik-worker",
    domains: ["piik.chius.dev"],
    workersDev: true,
    compatibilityDate: "2026-10-25",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint,
    assets: {
      notFoundHandling: "single-page-application",
      runWorkerFirst: true,
    },
    env: {
      ASSETS: bindings.assets(),
      REALTIME_SFU_APP_ID: bindings.secret(),
      REALTIME_SFU_BEARER_TOKEN: bindings.secret(),
      TURN_KEY_ID: bindings.secret(),
      TURN_API_TOKEN: bindings.secret(),
    },
    exports: { Room: exports.durableObject({ storage: "sqlite" }) },
    observability: {
      enabled: true,
      logs: { enabled: true },
      traces: { enabled: true, headSamplingRate: 0.1 },
    },
  },
});
