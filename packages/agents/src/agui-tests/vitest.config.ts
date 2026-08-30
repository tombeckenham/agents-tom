import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: path.join(import.meta.dirname, "wrangler.jsonc")
      }
    })
  ],
  test: {
    name: "agui",
    include: [path.join(import.meta.dirname, "**/*.test.ts")],
    testTimeout: 10_000,
    // Matches the legacy ai-chat workers suite: under the full parallel matrix
    // these WebSocket turns can overrun 10s waiting on a contended isolate.
    // Failures under load are always timeouts, never assertions.
    retry: 3,
    teardownTimeout: 60_000
  }
});
