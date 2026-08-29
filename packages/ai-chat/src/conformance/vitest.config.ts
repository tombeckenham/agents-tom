import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { stripNodeModulesSourceMapReferences } from "../../../../scripts/vitest/strip-node-modules-source-map-references";
import { defineConfig } from "vitest/config";

const dir = import.meta.dirname;

export default defineConfig({
  resolve: {
    dedupe: ["vitest"]
  },
  plugins: [
    stripNodeModulesSourceMapReferences(),
    cloudflareTest({
      wrangler: {
        configPath: path.join(dir, "wrangler.jsonc")
      }
    })
  ],
  test: {
    name: "conformance",
    include: [path.join(dir, "**/*.test.ts")],
    testTimeout: 15_000,
    teardownTimeout: 60_000,
    // Goldens are vitest file snapshots: UPDATE_GOLDENS=1 re-records them.
    // No retry — a golden that only passes on retry is nondeterministic.
    update: process.env.UPDATE_GOLDENS === "1",
    deps: {
      optimizer: {
        ssr: {
          // Same workaround as src/tests/vitest.config.ts (ajv via MCP SDK).
          include: ["ajv"]
        }
      }
    }
  }
});
