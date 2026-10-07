---
"agents": patch
"@cloudflare/ai-chat": patch
---

`AGUIChatAgent` (and `AIChatAgent` on top of it) now sends a request's terminal frames after the transcript is persisted and broadcast, so a message sent right after a reply is no longer replaced by a late snapshot. A failed save turns the held `done` frame into an error.

Terminal frames carry `messageIds` (the user messages the request originated from, also across recovery) and `outcome` (`aborted`, `skipped`, `recovering`, `error`, or `completed` for a turn that produced no response, which now also reaches the originating connection). Every stored stream event is broadcast with its `seq`, the index its replay carries. An in-band `RUN_ERROR` is sent on an `error: true` frame and its stream is recorded as errored, so a reconnecting client replays the partial that preceded the error.
