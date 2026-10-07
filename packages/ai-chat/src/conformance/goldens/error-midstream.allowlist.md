A mid-stream error rides the AG-UI `RUN_ERROR` event (projected to an AI SDK
`error` chunk) on the envelope `error: true` frame, where legacy's body was
the raw error string. Everything else — the frame's `error` flag and
`messageIds`, message, terminal done frame and its `outcome`, hook status,
partial `state: "streaming"` row — must still match the golden.

- `clients[*].frames[3].body` — legacy body was the raw error string; projected is the `{type:"error",errorText}` chunk.
- `clients[*].frames[3].seq` — the engine stores `RUN_ERROR` in the stream log (it is replayed with the pre-error partial, #1575), so the frame carries its replay index; legacy never stored the error chunk.
