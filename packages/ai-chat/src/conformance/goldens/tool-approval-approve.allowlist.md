Frame granularity: the approval decision/result apply syncs via a
`cf_agent_chat_messages` snapshot instead of legacy's folded-assistant
`cf_agent_message_updated`. Part ordering inside the rows matches the golden
(preserved by the `partOrder` CF extension).

- `clients[*].frames[5].type` — snapshot (`cf_agent_chat_messages`) vs legacy folded `cf_agent_message_updated`.
- `clients[*].frames[5].message` — the folded single message legacy carried on that frame.
- `clients[*].frames[5].messages` — the snapshot list the projected stack carries instead.
- `clients[*].frames[9].body.messageId` — the continuation's leading `start` now carries the assistant id (legacy sent an id-less `start`).
- `clients[*].frames[*].id` — normalized id-slot swap: the snapshot frame introduces the user row id before the continuation request id.
- `clients[*].frames[*].messages[*].id` — same id-slot swap inside the snapshot.
- `hooks[*].requestId` — same id-slot swap.
- `persistedRows[*].id` — same id-slot swap.
- `persistedRows[*].message.id` — same id-slot swap.
- `clientView[*].id` — same id-slot swap.
