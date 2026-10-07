---
"agents": patch
"@cloudflare/ai-chat": patch
---

`AGUIChatAgent` (and `AIChatAgent` on top of it) now runs chat turns and recovery continuations on Tasks, following upstream #2194, #2190, #2223, #2360, #2385 and #2393.

- **Recovery on Tasks.** Each recovery attempt is one `__cf_internal_chat_recovery` Task run instead of a schedule row. The run returns at the model handoff, so a long recovered turn no longer holds the job queue, and recovery runs are members of the alarm memory-limit breaker again. A root agent's chat turn is itself a Task run; a turn on a sub-agent stays on a fiber.
- **Progress marker.** Recovery progress is derived from the stream log rather than a counter written per chunk. A settled tool result is flushed as it arrives.
- **Transient reader errors.** A platform transient while reading the response (a dropped connection, for example) is routed into bounded recovery with exponential backoff, like a stall, instead of ending the turn with an error. `onChatRecovery` is consulted with the live turn's `stash()` data and start time; `{ continue: false }` keeps the error terminal and `{ persist: false }` drops the partial and retries the turn. A new turn that failed before producing anything is re-run rather than continued. Stalls and transient errors share one retry bound per incident.
- **Cancel during backoff.** Cancelling a request whose recovery is waiting out its backoff cancels the queued attempt.
- **Continuation failures.** An auto-continuation that fails before it streams (the handler throws, or the response body cannot be read) sends an error frame and reaches `onChatResponse` with `status: "error"`.
