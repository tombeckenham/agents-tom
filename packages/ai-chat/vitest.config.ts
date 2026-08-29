import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "src/tests/vitest.config.ts",
      "src/react-tests/vitest.config.ts",
      "src/react-tests/vitest.agui.config.ts",
      "src/conformance/vitest.config.ts"
    ]
  }
});
