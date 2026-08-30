Row/frame granularity from frame 7 onward: the client tool result applies as
a standalone AG-UI tool row synced via a `cf_agent_chat_messages` snapshot +
tool-row `cf_agent_message_updated` (legacy re-sent the folded assistant),
adding one frame and shifting every later index; and the AI SDK-only
`preliminary: false` marker has no AG-UI representation. Frames 0–6 (the tool
call turn), row/view content, and hook statuses must still match the golden.

- `clients[*].frames.length` — one extra frame from the snapshot + tool-row granularity.
- `clients[*].frames[7].**` — start of the shifted window (snapshot vs folded update).
- `clients[*].frames[8].**` — shifted window.
- `clients[*].frames[9].**` — shifted window.
- `clients[*].frames[10].**` — shifted window.
- `clients[*].frames[11].**` — shifted window.
- `clients[*].frames[12].**` — shifted window.
- `clients[*].frames[13].**` — shifted window.
- `clients[*].frames[14].**` — shifted window.
- `clients[*].frames[15].**` — shifted window.
- `clients[*].frames[16].**` — shifted window.
- `clients[*].frames[17].**` — shifted window (the added frame).
- `hooks[*].requestId` — normalized id-slot swap from the snapshot frame.
- `persistedRows[*].id` — same id-slot swap.
- `persistedRows[*].message.id` — same id-slot swap.
- `clientView[*].id` — same id-slot swap.
- `persistedRows[*].message.parts[*].preliminary` — AI SDK-only marker with no AG-UI slot; dropped on round trip.
- `clientView[*].parts[*].preliminary` — same dropped marker.
