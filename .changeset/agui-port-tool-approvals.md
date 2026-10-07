---
"agents": patch
"@cloudflare/ai-chat": patch
---

Bring the AG-UI chat engine up to date with recent tool-approval and tool-state fixes:

- A pending automatic continuation no longer fires after the active stream finishes with a normal assistant response (`finishReason: "stop"`), unless a sibling tool call is still awaiting its result (#2352).
- A tool call whose arguments complete after its approval request keeps both: the approval snapshot is persisted again with the input, and AI SDK clients receive the approval request again after the input (#2391).
- An approved tool call that never ran is settled with an error result once a new turn moves past it, instead of reaching the provider without a result (#2392). The same pre-turn repair now also runs on submitted turns.
- Reused tool-call IDs reconcile one-to-one: a later assistant no longer adopts an earlier row's ID, tool results merge only from the row a message resolved to, and a stale pending copy of an assistant echoed in the same submit is not persisted (#2040).
