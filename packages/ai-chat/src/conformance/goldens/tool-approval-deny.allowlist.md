Frame granularity from frame 5 onward: the deny decision is broadcast as its
own AG-UI CUSTOM mini-stream (projected to `start` + `tool-output-denied`)
and the apply syncs via a `cf_agent_chat_messages` snapshot, where legacy
re-sent the folded assistant via `cf_agent_message_updated`; the extra frames
shift every later index. Frames 0–4 (the tool-call turn itself), rows, and
view must still match the golden.

- `clients[*].frames.length` — two extra frames from the deny mini-stream + snapshot granularity.
- `clients[*].frames[5].**` — start of the shifted window (deny mini-stream vs folded update).
- `clients[*].frames[6].**` — shifted window.
- `clients[*].frames[7].**` — shifted window.
- `clients[*].frames[8].**` — shifted window.
- `clients[*].frames[9].**` — shifted window.
- `clients[*].frames[10].**` — shifted window.
- `clients[*].frames[11].**` — shifted window.
- `clients[*].frames[12].**` — shifted window.
- `clients[*].frames[13].**` — shifted window.
- `clients[*].frames[14].**` — shifted window.
- `clients[*].frames[15].**` — shifted window.
- `clients[*].frames[16].**` — shifted window.
- `hooks[*].requestId` — normalized id-slot swap from the snapshot frame.
