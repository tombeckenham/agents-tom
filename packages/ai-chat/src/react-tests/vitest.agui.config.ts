import path from "node:path";
import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

const testsDir = import.meta.dirname;

// Runs the SAME `use-agent-chat.test.tsx` suite against the AG-UI hook: the
// alias swaps `../react` (the legacy re-export) for the shim, which pairs the
// new hook with a chunk→AG-UI wire codec. See `agui-hook-shim.tsx`.
export default defineConfig({
  define: {
    "globalThis.IS_REACT_ACT_ENVIRONMENT": true
  },
  resolve: {
    alias: [
      {
        find: /^\.\.\/react$/,
        replacement: path.join(testsDir, "agui-hook-shim.tsx")
      }
    ]
  },
  test: {
    name: "react-agui",
    // One documented wire divergence (Phase-5 allowlist candidate, not a hook
    // bug): the legacy wire's bare `{type:"start", messageId}` chunk has no
    // AG-UI counterpart — `RUN_STARTED` carries no message id — so an
    // assistant message materializes when its first content event arrives
    // rather than at run start. This test dispatches ONLY a `start` and
    // asserts the empty assistant shell appears with the server's id; every
    // other resumption test in the suite runs unchanged.
    testNamePattern:
      /^(?!.*does not remove a completed hydrated assistant when resume belongs to a different message).*$/,
    retry: 3,
    include: [
      path.join(testsDir, "use-agent-chat.test.tsx"),
      // AG-UI-wire-specific frames, driving the hook directly (no shim).
      path.join(testsDir, "use-agent-chat-agui.test.tsx")
    ],
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
