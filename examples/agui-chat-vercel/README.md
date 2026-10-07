# AG-UI Chat — Vercel AI SDK adapter

The `examples/ai-chat` agent, moved onto the AG-UI canonical path via
[`@cloudflare/ai-chat-vercel`](../../packages/ai-chat-vercel).

The point of this example is how little changes. Against the legacy
version, the diff is three lines on the server and one on the client.

## Server

```diff
-import { AIChatAgent } from "@cloudflare/ai-chat";
+import { AGUIChatAgent } from "agents/agui-chat-agent";
+import { toAGUIResponse, toUIMessages } from "@cloudflare/ai-chat-vercel";

-export class ChatAgent extends AIChatAgent<Env> {
+export class ChatAgent extends AGUIChatAgent<Env> {
   async onChatMessage(_onFinish, options) {
     const result = streamText({
-      messages: await convertToModelMessages(this.messages),
+      messages: await convertToModelMessages(toUIMessages(this.messages)),
       ...
     });
-    return result.toUIMessageStreamResponse();
+    return toAGUIResponse(result.toUIMessageStreamResponse());
   }
 }
```

`this.messages` is canonical AG-UI now, so it goes through `toUIMessages()`
before the AI SDK sees it. `toAGUIResponse()` projects the outgoing
`UIMessageChunk` stream into AG-UI SSE.

## Client

```diff
-import { useAgentChat } from "@cloudflare/ai-chat/react";
+import { useAgentChat } from "@cloudflare/ai-chat-vercel/react";
```

The hook's surface — `messages`, `sendMessage`, `clearHistory`, `stop`,
`isStreaming`, `onToolCall`/`addToolOutput` — is deliberately unchanged, so
the rest of the component is identical to the legacy example.

## What it demonstrates

- Streaming text over the AG-UI wire format
- A server-side tool (`getWeather`) that executes automatically
- A client-side tool (`getUserTimezone`) resolved through `onToolCall`
- Persistence in the AG-UI row format, with `maxPersistedMessages`

## Run it

```sh
pnpm install
pnpm start
```

Needs a Workers AI binding; `wrangler dev` proxies to real Workers AI, so
this path requires network access and Cloudflare auth.
