---
"agents": minor
"@cloudflare/ai-chat": minor
---

Store the AG-UI chat transcript in Sessions.

`AGUIChatAgent` (and `AIChatAgent`, which runs on it) now keeps its transcript in the Sessions capability instead of the `cf_ai_chat_agent_messages` table. Each row holds one AG-UI message; the engine uses the session named `"agui"`, reachable as `this.sessions.session("agui")`.

- **Migration.** On start, a Durable Object's existing transcript is moved over and its source removed: rows in `cf_ai_chat_agent_messages` (legacy AI SDK rows or AG-UI rows), and `UIMessage` rows the upstream `AIChatAgent` stored in the default session. A source with a row that cannot be migrated is left in place.
- **No size limit on a message.** A message larger than one SQLite row is split across rows and read back whole, and inline images move to the attachment store. Oversized tool outputs and text are no longer truncated or skipped.
- **Stream cutover.** A finished turn's messages are written in the same transaction that settles its stream and deletes the stream's rows. Agent-tool child turns keep their rows for the parent to read.
- **`/get-messages`.** `AIChatAgent` serves `UIMessage[]`, matching `this.messages`. `AGUIChatAgent` still serves AG-UI rows.
- `this.messages` is hydrated in `onStart` rather than the constructor.
- `agents/chat` exports `toSessionMessage` and `fromSessionMessage`, the codec between an AG-UI message and its Sessions row.
