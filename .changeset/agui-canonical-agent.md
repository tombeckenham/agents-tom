---
"agents": minor
---

Add `AGUIChatAgent` (`agents/agui-chat-agent`), a chat agent whose canonical message and stream shape is AG-UI instead of the Vercel AI SDK, plus the supporting AG-UI primitives under `agents/chat` and the `agents/chat/agui-types` export.

Adds `agents/chat/agui-ws-transport`: the shared client-side WebSocket transport for the `CF_AGENT_*` envelope with AG-UI bodies (request, resume replay and tool-continuation streams, cancellation policy and request bookkeeping in one place). The TanStack and AI SDK client adapters are thin glue over it.

`AGUIChatAgent` reuses the same format-agnostic engine as `AIChatAgent` (turn queue, submit concurrency, abort registry, continuation state, resumable streams) and the same wire envelope and SQLite schema, so an existing agent's storage is readable in place; legacy `UIMessage` rows are auto-migrated to the AG-UI shape on load. `onChatMessage` returns a `Response` carrying AG-UI SSE (`data: {…AGUIEvent}` frames). If `onChatMessage` throws before producing a `Response`, the request now terminates with an `error: true, done: true` frame instead of leaving clients waiting.

`AGUIChatAgent` carries the same reliability surface as `AIChatAgent`:

- **Durable chat recovery** — every turn runs in a durable fiber; `chatRecovery` tunes retry budgets and terminal behavior, `onChatRecovery` hooks each recovery decision, and an exhausted budget records a durable terminal so a disconnected client still learns the turn failed.
- **`chatStreamStallTimeoutMs`** — opt-in inactivity watchdog (default `0`). A model/transport stream that parks between chunks is aborted into the same bounded-recovery machinery a deploy interruption uses, instead of hanging forever.
- **Terminal replay on resume** — a client reconnecting after a failed turn is served the recorded terminal frame rather than silence.
- **Auto-continuation** — tool results/approvals flagged `autoContinue` schedule a continuation through the shared barrier: siblings coalesce into one turn, and the turn fires only once the whole parallel tool batch is answered and no stream is in flight.

Also adds `getServerTools()` to the MCP client (`agents/mcp/tanstack-ai`), projecting MCP tools into TanStack AI `ServerTool`s.

Three `agents/chat` exports whose only consumer was the pre-cutover `AIChatAgent` are removed: `isReplayChunk`, `reconcileOrphanPartial`, and the `BroadcastTransitionResult` type alias. `agents/chat` is a public subpath and the first two were announced in this changelog when they were added, but they are undocumented outside it, exist to support the legacy `AIChatAgent` internals, and are removed alongside it. Nothing in `@cloudflare/ai-chat` or `@cloudflare/think` uses them; the AG-UI reducer (`agents/chat/agui-message-builder`) has its own replay detection and idempotent orphan reconstruction. If you imported either directly, copy the previous implementation — both were self-contained pure functions.
