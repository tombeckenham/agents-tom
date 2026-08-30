# Migrating to the AG-UI engine (`@cloudflare/ai-chat` v1)

`@cloudflare/ai-chat` v1 rebuilds `AIChatAgent` on top of `AGUIChatAgent`, the AG-UI canonical chat engine in the `agents` package. The engine owns turns, persistence, streaming, recovery, and transport; `AIChatAgent` is now a projection layer that keeps the AI SDK surface on top of it.

**The public API does not change.** `onChatMessage` still returns an AI SDK stream `Response`, `this.messages` is still `UIMessage[]`, the lifecycle hooks keep their signatures, and `useAgentChat` keeps its options and return values. A differential conformance suite pins wire, persistence, and view behaviour against the previous implementation across 26 scenarios.

What does change is storage, one wire frame's payload shape, and a small set of protected internals. Most applications need only the dependency bump.

## Installation

```bash
npm install @cloudflare/ai-chat@^1 agents@latest
```

`agents` is a peer dependency at `>= 0.21.0`, and `@cloudflare/ai-chat` v1 imports `agents/agui-chat-agent` and `agents/chat/agui-ws-transport` from it at runtime. Upgrade both together — installing v1 against an `agents` release that predates those entry points fails at import time, not silently.

## Breaking changes

### 1. Persisted rows change shape, one way

Conversations are stored as AG-UI rows, marked `_v: "v6_agui_message"`. The first time an agent loads a history written by an earlier release, those `UIMessage` rows are migrated in place. The migration is automatic, and it is one way — there is no downgrade path once an agent has loaded.

**Action:** none for most applications. If you read `cf_ai_chat_agent_messages` directly, project the rows before treating them as `UIMessage`:

```typescript
import { toUIMessages } from "@cloudflare/ai-chat";
import type { AGUIMessage } from "agents/chat/agui-types";

const rows =
  this.sql`select message from cf_ai_chat_agent_messages order by created_at` ??
  [];
const messages = toUIMessages(
  rows.map((row) => JSON.parse(row.message as string) as AGUIMessage)
);
```

Activity messages have no `UIMessage` counterpart and are dropped on this projection. That is the one lossy edge.

**Before upgrading a deployment that matters, take a backup.** The migration is not reversible.

### 2. `maxPersistedMessages` counts rows, and tool results are their own rows

AG-UI stores a tool result as a standalone `role: "tool"` row rather than folding it onto the assistant turn that issued the call. `maxPersistedMessages` counts rows, so a turn with one tool call now costs three rows instead of two.

At small limits this changes which turns survive. Trimming to 2 keeps `[assistant, tool]` where the previous implementation kept `[user, assistant]` — the user's own turn can drop out of persisted history and out of `/get-messages`.

**Action:** if you set a small limit, re-tune it. Budget roughly one extra row per expected tool call. Large limits (the common case, for example `200`) are unaffected in practice.

```typescript
export class ChatAgent extends AIChatAgent {
  // was 20 — raise it to keep the same number of conversational turns
  maxPersistedMessages = 30;
}
```

### 3. `cf_agent_message_updated` carries a raw AG-UI row

The `CF_AGENT_MESSAGE_UPDATED` and `CF_AGENT_CHAT_MESSAGES` frames now carry AG-UI rows rather than `UIMessage` objects. A row can have `role: "tool"`, which is not a valid `UIMessage` role.

**Action:** none if you use `useAgentChat` — the shipped clients handle this. If you consume the frames directly, project them:

```typescript
import { toUIMessages } from "@cloudflare/ai-chat";
import { autoTransformAGUIMessages } from "agents/chat";

const messages = toUIMessages(autoTransformAGUIMessages(frame.messages));
```

`autoTransformAGUIMessages` also migrates any legacy rows it is handed, so the same call works across the upgrade boundary.

### 4. `this.messages` is a frozen projection

`this.messages` is rebuilt from the persisted rows on each read and returned frozen. In-place mutation now throws a `TypeError`.

```typescript
// Throws
this.messages.push(newMessage);
this.messages.sort(byTimestamp);

// Assign, or hand the new list to saveMessages / persistMessages
await this.saveMessages([...this.messages, newMessage]);
await this.persistMessages([...this.messages].sort(byTimestamp));
```

### 5. Removed protected internals

These had no public contract and have no replacement:

| Removed                     | What replaces it                                                |
| --------------------------- | --------------------------------------------------------------- |
| `_restoreActiveStream`      | The engine's idempotent orphan replay, which runs automatically |
| `_resolveOrphanTargetId`    | Same                                                            |
| `_orphanStore`              | Same                                                            |
| `repairInterruptedToolPart` | Same — interrupted tool parts are reconstructed by the engine   |

**Action:** subclasses that overrode any of these must drop the override and move the behaviour onto the public hooks (`onChatMessage`, `onChatResponse`, `sanitizeMessageForPersistence`). If you overrode them to work around interrupted-stream reconstruction, try removing the override first — that is the case the engine now handles itself.

## One intentional behaviour change

When `onChatMessage` throws **before** returning a `Response`, the requesting client now receives a terminal `error: true` done frame. The previous implementation sent that client nothing, leaving it waiting on a stream that would never arrive.

This is a fix, not a regression, but it is a behaviour change: a client that relied on the hang (for example, a test asserting no frame arrives) will now see the terminal frame.

## New exports

For applications that want to extend `AGUIChatAgent` directly while still building streams with the AI SDK:

| Export           | Purpose                                                                           |
| ---------------- | --------------------------------------------------------------------------------- |
| `toAGUIResponse` | Wrap a `streamText().toUIMessageStreamResponse()` into AG-UI SSE                  |
| `toUIMessages`   | Project canonical AG-UI rows back to `UIMessage[]` for `convertToModelMessages()` |

Neither is needed when extending `AIChatAgent` — it applies both internally. See the variant section in [`examples/ai-chat`](https://github.com/cloudflare/agents/tree/main/examples/ai-chat) for the three-line diff.

## What does not change

- `onChatMessage`, `onChatResponse`, `sanitizeMessageForPersistence`, and every other documented hook
- `saveMessages`, `persistMessages`, `continueLastTurn`, and their return shapes
- `useAgentChat` options, return values, `onToolCall`, and `addToolOutput`
- `messageConcurrency`, `waitForMcpConnections`, request cancellation, resumable streaming
- Server-side tools, client-side tools, and tool approval
- Data parts, custom request data, and row size protection

## Related docs

- [Chat Agents](./chat-agents.md) — full reference for `AIChatAgent` and `useAgentChat`
- [Migration to AI SDK v6](./migration-to-ai-sdk-v6.md) — an unrelated, independent upgrade
