---
"@cloudflare/ai-chat-tanstack": minor
---

Initial release of the TanStack AI client adapter for `AGUIChatAgent`.

`@cloudflare/ai-chat-tanstack` connects TanStack AI's `useChat`/`stream()` to an agent over WebSockets — an identity adapter, since TanStack AI consumes AG-UI events natively. It ships a `WebSocketChatTransport` with cancellation, stream resume, and tool-continuation handshakes, plus React hooks. The equivalent Vercel AI SDK adapter is not a separate package: it ships inside `@cloudflare/ai-chat`, which is itself the AI SDK projection layer over the AG-UI engine.
