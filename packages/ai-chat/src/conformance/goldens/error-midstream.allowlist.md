A mid-stream error rides the AG-UI `RUN_ERROR` event (projected to an AI SDK
`error` chunk frame) instead of legacy's raw-string body + envelope
`error: true` frame. Everything else — message, terminal done frame, hook
status, partial `state: "streaming"` row — must still match the golden.

- `clients[*].frames[3].error` — legacy set envelope `error: true`; the projected wire carries the error inside the chunk body instead.
- `clients[*].frames[3].body` — legacy body was the raw error string; projected is the `{type:"error",errorText}` chunk.
