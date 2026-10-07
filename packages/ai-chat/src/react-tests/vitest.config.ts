import path from "node:path";
import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

const testsDir = import.meta.dirname;

// Post-cutover there is one React client (the AG-UI hook re-exported by
// `../react`). `use-agent-chat.test.tsx` still dispatches LEGACY
// UIMessageChunk wire frames — the alias swaps `../react` for the shim, which
// re-frames them as AG-UI events via the same `chunk-to-event` projection the
// server uses (see `agui-hook-shim.tsx`), so the pre-cutover hook suite keeps
// gating the new hook. `use-agent-chat-agui.test.tsx` drives the hook with
// native AG-UI frames, no shim.
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
    name: "react",
    // One documented wire divergence (Phase-5 allowlist, not a hook bug): the
    // legacy wire's bare `{type:"start", messageId}` chunk has no AG-UI
    // counterpart — `RUN_STARTED` carries no message id — so an assistant
    // message materializes when its first content event arrives rather than
    // at run start. This test dispatches ONLY a `start` and asserts the empty
    // assistant shell appears with the server's id; every other resumption
    // test in the suite runs unchanged.
    testNamePattern:
      /^(?!.*does not remove a completed hydrated assistant when resume belongs to a different message).*$/,
    retry: 3,
    include: [
      path.join(testsDir, "use-agent-chat.test.tsx"),
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
