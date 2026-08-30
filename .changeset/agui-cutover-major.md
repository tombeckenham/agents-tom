---
"@cloudflare/ai-chat": major
---

`AIChatAgent` now runs on the AG-UI engine. The public API is unchanged
(`onChatMessage` returns an AI SDK stream `Response`, `this.messages` is
`UIMessage[]`, hooks keep their signatures), and a differential conformance
suite pins wire/persistence/view behavior against the previous
implementation — but the following are breaking:

- **Persisted rows flip to the AG-UI shape** (`_v: "v6_agui_message"`),
  one-way on first load. Legacy `UIMessage` rows migrate automatically;
  `toUIMessages` (from `agents/chat`) projects AG-UI rows back if you read
  the table directly.
- **`maxPersistedMessages` now counts AG-UI rows, and tool results are
  separate rows.** A trim that used to keep `[user, assistant]` can now keep
  `[assistant, tool]` — at small limits the user's own turn can drop out of
  the persisted history and `/get-messages`. Re-tune the value if you set a
  small limit (roughly: budget one extra row per expected tool call).
- **`cf_agent_message_updated` frames carry a raw AG-UI row**, which can have
  `role: "tool"` — not a valid `UIMessage` role. The shipped clients handle
  this; custom consumers of the frame must project via `toUIMessages` /
  `autoTransformAGUIMessages`.
- **`this.messages` is a frozen projection** — in-place mutation
  (`this.messages.push(...)`) now throws `TypeError`. Assign, or pass the new
  list to `saveMessages`/`persistMessages`.
- **Removed protected internals with no replacement**:
  `_restoreActiveStream`, `_resolveOrphanTargetId`, `_orphanStore`, and the
  `repairInterruptedToolPart` hook. Interrupted-stream reconstruction is now
  the engine's idempotent orphan replay; subclasses that overrode these must
  migrate onto the public hooks.
- **Peer dependency `agents` >= 0.21.0** (the package now imports
  `agents/agui-chat-agent`).

`useAgentChat` and `WebSocketChatTransport` speak AG-UI on the wire and
project to `UIMessageChunk` client-side; the browser-visible API is
unchanged.
