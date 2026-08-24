import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["src/__tests__/vitest.config.ts"]
  }
});
