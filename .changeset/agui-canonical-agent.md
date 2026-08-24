---
"agents": minor
---

Add `AGUIChatAgent` (`agents/agui-chat-agent`), a chat agent whose canonical message and stream shape is AG-UI instead of the Vercel AI SDK, plus the supporting AG-UI primitives under `agents/chat` and the `agents/chat/agui-types` export.

`AGUIChatAgent` reuses the same format-agnostic engine as `AIChatAgent` (turn queue, submit concurrency, abort registry, continuation state, resumable streams) and the same wire envelope and SQLite schema, so an existing agent's storage is readable in place; legacy `UIMessage` rows are auto-migrated to the AG-UI shape on load. `onChatMessage` returns a `Response` carrying AG-UI SSE (`data: {…AGUIEvent}` frames). If `onChatMessage` throws before producing a `Response`, the request now terminates with an `error: true, done: true` frame instead of leaving clients waiting.

Also adds `getServerTools()` to the MCP client (`agents/mcp/tanstack-ai`), projecting MCP tools into TanStack AI `ServerTool`s.
