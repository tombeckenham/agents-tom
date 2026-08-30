# AG-UI Chat — TanStack AI adapter

The [`examples/ai-chat`](../ai-chat) agent, driven by
[`@tanstack/ai`](https://tanstack.com/ai) through
[`@cloudflare/ai-chat-tanstack`](../../packages/ai-chat-tanstack).

This is the example that motivates the RFC. TanStack's `chat()` already
emits AG-UI, so on this path there is **no projection at all** — the server
helper only frames an existing event stream as SSE:

```ts
const stream = chat({ adapter, stream: true, messages, systemPrompts });
return toAGUIResponse(stream);
```

Compare with the AI SDK path (`examples/ai-chat`, and the `AGUIChatAgent`
variant documented in its README), where `toAGUIResponse()` has to translate
a `UIMessageChunk` stream into AG-UI events first. Same agent, same wire
format, same persisted rows — the adapter absorbs the difference.

The message projection tells the same story. `toModelMessages()` here is a
field rename and a role fold, because TanStack's `ModelMessage` already
carries `role` / `content` / `toolCalls` / `toolCallId` with AG-UI's
meanings. `toUIMessages()` on the AI SDK path has to reshape tool results
onto the assistant turn that issued them.

## Client

```ts
import { useAgentChat } from "@cloudflare/ai-chat-tanstack/react";

const { messages, sendMessage, stop, isStreaming } = useAgentChat({ agent });
```

`useAgentChat` wraps `@tanstack/ai-react`'s `useChat` through a
WebSocket-backed `stream()` connection adapter. Message parts are TanStack's
shape (`part.content`) rather than the AI SDK's (`part.text`) — the one
place app code genuinely differs between the two adapters.

## Run it

```sh
pnpm install
pnpm start
```

Needs a Workers AI binding; `wrangler dev` proxies to real Workers AI, so
this path requires network access and Cloudflare auth.
