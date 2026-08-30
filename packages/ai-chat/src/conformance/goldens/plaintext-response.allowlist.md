The engine synthesizes a full TEXT lifecycle for plaintext bodies, so the
wire differs frame-for-frame (leading `start` with the assistant id +
start/delta/end where legacy sent one raw text chunk). Text content, rows,
hooks, and view must still match the golden up to id slots.

- `clients[*].frames.**` — synthesized TEXT lifecycle: legacy sent [text-start, text-delta, text-end, done]; projected sends [start(messageId), text-start, text-delta, text-end, done].
- `hooks[*].messageId` — normalized id-slot shift: the assistant id now appears on the wire first.
- `hooks[*].requestId` — same id-slot shift.
- `persistedRows[*].id` — same id-slot shift.
- `persistedRows[*].message.id` — same id-slot shift.
- `clientView[*].id` — same id-slot shift.
