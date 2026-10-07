---
"@cloudflare/ai-chat-tanstack": patch
---

`toAGUIResponse` now copies TanStack AI's finish reason onto `RUN_FINISHED.result.finishReason`, where `AGUIChatAgent` reads it. A client tool result that arrives while a run is still streaming no longer triggers a second, stale turn after the run finishes with `stop`.
