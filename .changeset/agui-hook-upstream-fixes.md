---
"@cloudflare/ai-chat": patch
"agents": patch
---

`useAgentChat` from `@cloudflare/ai-chat/react` picks up the fixes the previous hook received while the AG-UI one was being built:

- `onTurnEnd` fires once for each chat request that ends, with its `messageIds` and `outcome`, after `status` has settled.
- `onToolCall` fires only once the response stream has ended, and stays held across a dropped socket or a `recovering` close until the turn is known to be over.
- A socket that closes mid-response ends the turn in `status: "error"` instead of reading as completed, and the cut-off reply no longer shadows the server's copy.
- A continuation replayed after a reconnect skips the frames the client already applied (by `seq`), and the server's snapshot replaces an observed reply whose text diverged from it.
- The hook follows the socket when the agent name changes, keeps a send that was buffered while the socket was down when the reconnect transcript omits it, and no longer hits React's update depth limit on long streams.

`WebSocketChatTransport` also no longer drops a request whose socket closed while its body was being prepared, and no longer stalls on a run that opens with two events that render nothing (`RUN_STARTED` then `STEP_STARTED`).

`AGUIWebSocketTransport` (`agents/chat/agui-ws-transport`) gains `appliedChunks`, `activeServerTurnId`, `frameOf(event)`, an `onBuffered` option on `openRequestStream`, and `interrupted` on the streams it returns.
