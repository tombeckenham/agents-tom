Intentional improvement: an `onChatMessage` throw before a Response now
broadcasts a terminal `error: true` done frame — legacy sent the requester
nothing, stranding it. Persisted user row and view content must still match.

- `clients[*].frames.**` — the golden has ZERO frames (the stranding bug); the projected stack emits exactly the one terminal error frame.
- `persistedRows[*].id` — normalized id-slot shift only: the request id now enters the id map first (via the terminal frame).
- `persistedRows[*].message.id` — same id-slot shift.
- `clientView[*].id` — same id-slot shift.
