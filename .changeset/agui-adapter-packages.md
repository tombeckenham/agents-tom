---
"@cloudflare/ai-chat-tanstack": minor
"@cloudflare/ai-chat-vercel": minor
---

Initial release of the AG-UI client adapters for `AGUIChatAgent`.

`@cloudflare/ai-chat-tanstack` connects TanStack AI's `useChat`/`stream()` to an agent over WebSockets — an identity adapter, since TanStack AI consumes AG-UI events natively. `@cloudflare/ai-chat-vercel` does the same for the Vercel AI SDK's `useChat`, projecting AG-UI events to and from `UIMessageChunk`s. Both ship a `WebSocketChatTransport` with cancellation, stream resume, and tool-continuation handshakes, plus React hooks.
