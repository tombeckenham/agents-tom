USER-VISIBLE BEHAVIOR CHANGE (called out in the major changeset):
`maxPersistedMessages` counts rows, and AG-UI stores tool results as separate
rows — trimming to 2 keeps [assistant, tool] (folding back to one assistant
message) where legacy kept [user, assistant]. At small limits the user's own
turn drops out of persisted history and `/get-messages`. The wire also shares
the client-tool-continuation snapshot granularity from frame 7 onward.

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
- `persistedRows.**` — the trim-behavior change itself: [assistant, tool] survives where legacy kept [user, assistant].
- `clientView.**` — projection of the same trimmed rows.
