import path from "node:path";
import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

const testsDir = import.meta.dirname;

export default defineConfig({
  define: {
    "globalThis.IS_REACT_ACT_ENVIRONMENT": true
  },
  test: {
    name: "react",
    // Retry flaky browser/Playwright runs before failing.
    retry: 3,
    include: [path.join(testsDir, "**/*.test.{ts,tsx}")],
    // AG-UI-wire-specific; belongs to the `react-agui` project only.
    exclude: [path.join(testsDir, "use-agent-chat-agui.test.tsx")],
    browser: {
      enabled: true,
      instances: [
        {
          browser: "chromium",
          headless: true
        }
      ],
      provider: playwright()
    },
    clearMocks: true
  }
});
