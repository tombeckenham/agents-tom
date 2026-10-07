---
"agents": patch
"@cloudflare/ai-chat": patch
---

A text or reasoning part that carried no `state` when it was stored (legacy rows lifted on start, or messages passed to `persistMessages`) is read back from `AIChatAgent` without one, as it was before the AG-UI engine. It was read back with `state: "done"`. Parts the agent streams still end as `"done"`. The AG-UI row records this as `stateless: true`.
