# UIMessage/UIMessageChunk Coupling Audit

**Phase 1 Discovery output**: Exhaustive map of every place the Cloudflare Agents SDK depends on `UIMessage`, `UIMessageChunk`, `ToolSet` and Vercel AI SDK shape semantics.

---

## Executive Summary

The codebase exhibits **two clear tiers of coupling**:

1. **Genuinely format-aware** (10–12 files): Files that intrinsically understand or manipulate the UIMessage/UIMessageChunk shape:
   - `message-builder.ts` – applies chunks to parts array
   - `sanitize.ts` – strips provider metadata, truncates text/output
   - `message-reconciler.ts` – dedupes and merges messages by content/toolCallId
   - `stream-accumulator.ts` – wraps chunk application with metadata tracking
   - `tool-state.ts` – applies tool part state mutations (minimal, reusable)
   - `broadcast-state.ts` – reconstructs messages for broadcast transitions
   - `ai-chat-v5-migration.ts` – converts v4 UIMessage rows to v5 format
   - `ws-chat-transport.ts` – parses UIMessageChunk, emits ReadableStream<UIMessageChunk>
   - `ai-chat/src/index.ts` – persistence, _reply SSE parsing, message construction
   - `ai-chat/src/react.tsx` – React hooks layer (imports from index.ts, uses UIMessage typings)

2. **Cosmetically typed but format-agnostic** (6–8 files): Files that accept or pass UIMessage as a container but don't depend on internal structure:
   - `turn-queue.ts` – pure async queue, no message awareness
   - `abort-registry.ts` – request-level cancellation, no message awareness
   - `continuation-state.ts` – connection + tool schema tracking, no message shape dependency
   - `resume-stream.ts` – chunk buffering + SQL replay, format-neutral
   - `parse-protocol.ts` – WebSocket message parsing, not message-shape-aware
   - `lifecycle.ts` – type definitions for public hooks (ChatResponseResult, etc.)
   - `client-tools.ts` – JSONSchema7 conversion, no message shape logic
   - `submit-concurrency.ts` – message ordering controller, no shape awareness

**Persistence layer** (`cf_ai_chat_agent_messages`):
- Currently stores `JSON.stringify(UIMessage)` with schema: `id text primary key | message text | created_at datetime`
- Migration function (`autoTransformMessages`) handles v4→v5 transformation on load; writes always use current format
- SSE parsing in `_streamSSEReply` consumes `UIMessageChunk`, applies via `applyChunkToParts`, persists final `UIMessage`

**Wire format** (`CF_AGENT_USE_CHAT_RESPONSE`):
- Body: SSE stream with `data: {...UIMessageChunk JSON}` lines
- Chunk types consumed today: text-{start,delta,end}, reasoning-{start,delta,end}, file, source-{url,document}, tool-{input,output,approval,input-error}, data-*, step-start, start-step, finish, start, message-metadata

**Risk & Gate analysis**: Message-builder, sanitize, and the _reply SSE parsing are the highest-coupling, highest-impact refactors. Persistence layer is highest-risk (data-shape migration). Everything else is either a thin re-export or structural type wrapping.

---

## Per-File Findings

### packages/agents/src/chat

| File | AI-SDK imports | UIMessage/UIMessageChunk usage | Coupling verdict | Notes |
|------|----------------|--------------------------------|------------------|-------|
| **message-builder.ts** | `type UIMessage` | Types: `MessageParts`, `MessagePart` (both UIMessage indexing). Functions: `applyChunkToParts(parts: MessagePart[], chunk)` mutates parts in-place by chunk type (line 78–404). `isReplayChunk(parts, chunk)` inspects existing parts state to suppress provider replays (line 430–447). Both are called from stream parsing and message accumulation. | **deep** | Core format-aware module. Knows: text/reasoning/tool lifecycle, tool state machine (input-streaming → input-available → output-available), approval-requested/output-denied, provider metadata merging, data-part reconciliation by type+id. Zero format-agnostic work. Replacement path: rewrite for `AGUIEvent` → `Message` snapshot. |
| **sanitize.ts** | `type UIMessage`, `ProviderMetadata`, `ReasoningUIPart` | Functions: `sanitizeMessage(message: UIMessage): UIMessage` (line 29) — strips OpenAI ephemeral fields (itemId, reasoningEncryptedContent), filters empty reasoning parts. `enforceRowSizeLimit(message: UIMessage)` (line 124) — truncates tool outputs >1KB, text parts, via `truncateToolOutput`. Returns UIMessage. | **deep** | Format-aware truncation logic. Knows: tool part shape (toolCallId, state, output), text part shape, reasoning part emptiness rules. Migrates wholesale. |
| **stream-accumulator.ts** | `type UIMessage` | Constructor: `StreamAccumulatorOptions { messageId, existingParts?: UIMessage["parts"], existingMetadata }`. Properties: `parts: UIMessage["parts"]`, `metadata?: Record<string, unknown>`. Method `applyChunk(chunk)` (line 74) delegates to `applyChunkToParts`, then detects cross-message tool updates, metadata chunks. Returns `ChunkAction` union. | **deep** | Wraps message-builder's applyChunkToParts. Adds metadata tracking (start/finish/message-metadata chunks) and cross-message tool-update signaling (line 88–111). **Can be rewritten**: `applyEventToSnapshot` for AG-UI; cross-message logic moves to caller. |
| **tool-state.ts** | (none) | Types: `ToolPartUpdate { toolCallId, matchStates, apply }`. Functions: `applyToolUpdate(parts, update)` (line 25) — finds part by toolCallId in matchStates, applies immutable update. `toolResultUpdate(toolCallId, output)` (line 51) — builds update for output-available/output-error. `toolApprovalUpdate(toolCallId, approved)` (line 82) — builds update for approval-responded/output-denied. | **cosmetic** | Pure state-machine update builder. Does not introspect message or part shapes; only pattern-matches toolCallId and state strings. Callable by any format as long as parts are objects with toolCallId/state. **Keep as-is** or minimal wrapper. |
| **message-reconciler.ts** | `type UIMessage` | Functions: `reconcileMessages(incoming, serverMessages, sanitize?)` (line 26) — merges server tool outputs into stale incoming messages, reconciles assistant IDs via exact match→content-key→toolCallId. `resolveToolMergeId(message, serverMessages)` (line 47) — single-message ID resolution by toolCallId. `assistantContentKey(message, sanitize?)` (line 72) — JSON stringifies sanitized parts for dedup. | **deep** | Knows: UIMessage.role, toolCallId in parts, output-available state, message ID semantics. Merges by examining message.role and part.state === "output-available". **Must migrate**: rewrite for AG-UI Message ID + toolCallId presence. |
| **broadcast-state.ts** | `type UIMessage` | Types: `BroadcastStreamState { status, accumulator }`, `BroadcastStreamEvent { type, currentMessages?: UIMessage[] }`. Function: `transition(state, event)` (line 63) — pure state machine. On 'response', creates/updates `StreamAccumulator`, calls `accumulator.mergeInto(prev: UIMessage[])` to merge into message list (line 128, 137). | **cosmetic** | Format-aware only at the accumulator boundary. `mergeInto` is format-aware (message-builder's responsibility), but the state machine itself is neutral. **Borderline**: can refactor by pushing format concern into accumulator. |
| **lifecycle.ts** | `type UIMessage` | Type definitions only: `ChatResponseResult { message: UIMessage, requestId, continuation, status }` (line 23), `ChatRecoveryContext { messages: UIMessage[], lastClientTools }` (line 96). No implementation. | **cosmetic** | Pure type wrapper for public hook signatures. **Keep as-is** (type aliases can be reused). |
| **turn-queue.ts** | (none) | (none) | **none** | Generic async queue with generation-based invalidation. No message awareness. **Keep as-is**. |
| **abort-registry.ts** | (none) | (none) | **none** | Per-request AbortController registry. No message awareness. **Keep as-is**. |
| **continuation-state.ts** | (none) from "ai"; imports `ClientToolSchema` | Types: `ContinuationPending { connection, clientTools?, body? }`, `ContinuationDeferred { ... }`. Class: no message methods. | **cosmetic** | Tracks connection + pending tool schema + body for continuation rounds. No message-shape logic. **Keep as-is**. |
| **resume-stream.ts** | (none) | Types: `StreamChunk { id, stream_id, body, chunk_index }`, `StreamMetadata { id, request_id, status }`. Methods: `addChunk(body)` (line 140+), `replayChunks(connection)` (line 200+), SQL-based buffering and replay. | **none** | Format-neutral chunk buffering. Body is opaque string (serialized StreamChunkData). **Keep as-is**. |
| **parse-protocol.ts** | (none) | Type: `ChatProtocolEvent` union (line 16) — discriminated by type string, carries `messages: unknown[]` (line 46) but does not introspect. | **none** | WebSocket message parser. Treats message payloads as opaque. **Keep as-is**. |
| **client-tools.ts** | `type JSONSchema7, Tool, ToolSet`, functions `tool()`, `jsonSchema()` from "ai" | Type: `ClientToolSchema { name, description?, parameters?: JSONSchema7 }`. Function: `createToolsFromClientSchemas(clientTools?)` (line 37) — converts to ToolSet by wrapping in `tool({ ... })` and `jsonSchema(...)`. No UIMessage logic. | **cosmetic** | Uses AI SDK ToolSet/Tool/jsonSchema types but not message-aware. **Keep as-is**. |
| **submit-concurrency.ts** | (none) | (none) | **none** | Message ordering controller. Tracks submit sequences, debounce state. No message logic. **Keep as-is**. |
| **agent-tools.ts** | (none); imports `applyChunkToParts` from message-builder | Function: `applyAgentToolEvent(state, message)` (line 121) — applies event to a `AgentToolRunState { parts: [] }`. Inside loop at line 87, calls `applyChunkToParts(parts, JSON.parse(event.body))`. | **cosmetic** | Reuses applyChunkToParts but on `AgentToolRunState.parts` (distinct from UIMessage.parts). When message-builder is rewritten, this call site also updates (same logic, same function signature, just different part-array origin). **Minimal migration**. |
| **index.ts** (agents/src/chat) | (none) | Re-exports from siblings. | **cosmetic** | Central barrel export. **Keep as-is** with updated re-exports. |

### packages/ai-chat/src

| File | AI-SDK imports | UIMessage/UIMessageChunk usage | Coupling verdict | Notes |
|------|----------------|--------------------------------|------------------|-------|
| **index.ts** (main AIChatAgent impl) | `type UIMessage, UIMessageChunk, StreamTextOnFinishCallback, TextUIPart, ToolSet` (line 1–7) | Core to entire file. Type: `ChatMessage = UIMessage` (line 86). Persistence: column `message text` stores `JSON.stringify(message: UIMessage)` via `persistMessages()` (line 2938–3003). Message loading `_loadMessagesFromDb()` (line 1364) parses JSON as UIMessage. Stream parsing `_streamSSEReply()` (line 3640+): reads SSE, parses each line as `UIMessageChunk` (line 3702), applies via `applyChunkToParts()` to build message. At stream end, persists `message: UIMessage` to SQLite. Tool updates via `_findAndUpdateToolPart()` (line 3859+), `_sanitizeMessageForPersistence()` (line 3089), `_enforceRowSizeLimit()` (line 3248). Early persistence at approval-requested (line 3815–3828): `UIMessage` snapshot. | **deep** | Entire implementation layer. Core activities: (1) SSE parsing → UIMessageChunk stream, (2) accumulation into UIMessage.parts, (3) persistence to SQLite as JSON string, (4) loading & migration (autoTransformMessages), (5) broadcast of UIMessage to clients, (6) tool reconciliation. Rewrite required for all 6 activities. Highest-risk subsystem: persistence migration. |
| **react.tsx** | Re-exports from index.ts; uses `useChat` from "@ai-sdk/react", `useCallback`, `useContext` | Imports: `ChatMessage` (= UIMessage alias from index), `ChatResponseResult`, etc. Hook `useAgentChat(options)` (main export) wraps `useChat` and uses `chatTransport?: ChatTransport<ChatMessage>` (line 62–ish). Maintains UI state (input, messages: ChatMessage[], isLoading, etc.). Forwards messages to transport, handles streaming. | **cosmetic** | React bindings. Depends on index.ts's UIMessage typings and ChatMessage alias, but does not introspect message shapes. All message manipulation is via useChat (AI SDK's responsibility). **Migrate: update type imports only** (ChatMessage changes but signature stays). |
| **ws-chat-transport.ts** | `type ChatTransport, UIMessage, UIMessageChunk` (line 11) | Class: `WebSocketChatTransport<ChatMessage extends UIMessage>` (line 66) implements AI SDK's `ChatTransport<ChatMessage>`. Methods: `sendMessage()` (line 200+) creates Request, calls agent.send(). `reconnectToStream(msgId)` (line 240+) returns `Promise<ReadableStream<UIMessageChunk>>`. Parsing at line 280+: listens to WebSocket, on CF_AGENT_USE_CHAT_RESPONSE, parses `body` as SSE, emits `UIMessageChunk` to stream. `_createToolContinuationStream()` (line 302) also emits `ReadableStream<UIMessageChunk>`. | **deep** | Vercel AI SDK transport adapter. Receives UIMessageChunk from agent's CF_AGENT_USE_CHAT_RESPONSE frames, emits as ReadableStream for useChat. Must emit exact shape expected by AI SDK. Rewrite: map incoming AG-UI events → UIMessageChunk for backward compat (in adapter), or reroute to AG-UI consumer directly. |
| **types.ts** | `type UIMessage` (line 1); `type JSONSchema7` from "ai" | Defines wire message types: `OutgoingMessage<ChatMessage extends UIMessage>` (line 33) with variant `CF_AGENT_MESSAGE_UPDATED { message: ChatMessage }` (line 69). `IncomingMessage<ChatMessage>` similarly typed. | **cosmetic** | Wire format envelope. Wraps ChatMessage (UIMessage) but doesn't introspect. **Can refactor**: replace ChatMessage with AG-UI Message type, keep envelope structure. |
| **ai-chat-v5-migration.ts** | `type UIMessage` (line 1) | Functions: `autoTransformMessages(messages: unknown[])` (line 298) — maps each message via `autoTransformMessage()` which transforms v4 rows (content string, toolInvocations array) to v5 (parts array). `isUIMessage()` (line 104) type guard. Returns `UIMessage[]`. | **deep** | Migration logic specific to UIMessage shape. Maps v4 `{ content: string, toolInvocations: [...] }` to v5 `{ parts: [...tool-${name}, text parts...] }`. Must be rewritten for AG-UI `Message` shape on next schema bump. | 
| Tests (in tests/, e2e-tests/, react-tests/) | Fixture data hardcodes UIMessage shapes | Snapshots and test fixtures contain JSON strings like `{ id, role, parts: [...] }`. | **cosmetic** | Fixtures will need regeneration after migration. Conversion logic can be tested against both old and new shapes. |

### packages/agents/src (thin re-exports)

| File | Content | Coupling verdict | Notes |
|------|---------|------------------|-------|
| **ai-chat-agent.ts** | `export * from "@cloudflare/ai-chat"` (line 1) + deprecation warning | **cosmetic** | Pure re-export. Becomes a shim for one major. |
| **ai-react.tsx** | `export * from "@cloudflare/ai-chat/react"` (line 1) + deprecation warning | **cosmetic** | Pure re-export. Becomes a shim for one major. |
| **ai-types.ts** | Re-exports `MessageType` enum from both agents and ai-chat (line 9–11) | **cosmetic** | Pure re-export. |

### packages/agents/src/mcp/client.ts

| Method | Signature | AI-SDK dependency | Coupling verdict | Notes |
|--------|-----------|-------------------|------------------|-------|
| **getAITools()** | `getAITools(filter?: MCPServerFilter): ToolSet` (line 1319) | Returns `ToolSet` (from "ai"). Builds entries: `{ [toolKey]: { description, title, execute, inputSchema: z.fromJSONSchema(...), outputSchema: ... } }` (line 1333–1380). | **cosmetic** | Returns Vercel ToolSet shape. No message awareness. execute() calls MCP server. **Keep as-is** for Vercel adapter; add `getServerTools()` returning TanStack shape as separate method. |

### packages/agents/src/codemode/ai.ts

| Content | Notes |
|---------|-------|
| `throw new Error("...")` (line 3) | Removed. Was deprecated Vercel-shaped tool export. No impact on refactor. |

---

## Persistence Section

### Schema

```sql
CREATE TABLE IF NOT EXISTS cf_ai_chat_agent_messages (
  id TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

### Current row format

```json
{
  "id": "msg-abc123",
  "role": "assistant",
  "parts": [
    {
      "type": "text",
      "text": "Hello, ",
      "state": "streaming"
    },
    {
      "type": "text",
      "text": "world!",
      "state": "done"
    },
    {
      "type": "tool-web_search",
      "toolCallId": "call_xyz",
      "toolName": "web_search",
      "state": "input-available",
      "input": { "query": "..." },
      "title": "Search"
    },
    {
      "type": "tool-web_search",
      "toolCallId": "call_xyz",
      "state": "output-available",
      "output": { "results": [...] }
    }
  ],
  "metadata": {
    "some": "value"
  }
}
```

### Migration on load

`autoTransformMessages()` converts v4 rows (schema below) to v5 on first load. Writes always use v5.

v4 schema (legacy):
```json
{
  "id": "msg-old",
  "role": "user",
  "content": "Original prompt",
  "reasoning": "Internal thought",
  "toolInvocations": [
    {
      "toolCallId": "call_old",
      "toolName": "search",
      "args": {"q": "..."},
      "state": "partial-call",
      "result": null
    }
  ]
}
```

Conversion rules (lines 94–99):
- `toolInvocations[].state: "partial-call"` → `input-streaming`
- `"call"` → `"input-available"`
- `"result"` → `"output-available"`
- `"error"` → `"output-error"`

---

## Wire-Format Section

### CF_AGENT_USE_CHAT_RESPONSE frame

```json
{
  "type": "cf_agent_use_chat_response",
  "id": "req-123",
  "body": "data: {...}\ndata: {...}\n",
  "done": false,
  "continuation": false,
  "replay": false
}
```

### SSE chunk types in body

Each `data: {...}` line is a JSON object. Recognized types in `applyChunkToParts()`:

**Text**:
- `text-start` — create text part, state: streaming
- `text-delta` — append delta to last text part
- `text-end` — set state: done

**Reasoning** (for o1, Claude with extended thinking):
- `reasoning-start` — create reasoning part, state: streaming, optionally providerMetadata
- `reasoning-delta` — append delta, merge providerMetadata
- `reasoning-end` — set state: done, merge providerMetadata

**File/Source**:
- `file` — create file part { type, mediaType, url }
- `source-url` — create source-url part { sourceId, url, title, providerMetadata }
- `source-document` — create source-document part { sourceId, mediaType, title, filename, providerMetadata }

**Tool Lifecycle** (detailed in message-builder.ts lines 184–358):
- `tool-input-start` — create tool-${toolName} part, state: input-streaming
- `tool-input-delta` — mutate input JSON while state is input-streaming
- `tool-input-available` — advance state from input-streaming to input-available
- `tool-input-error` — set state: output-error, errorText
- `tool-approval-request` — set state: approval-requested, add approval: { id }
- `tool-output-available` — set state: output-available, output, preliminary?
- `tool-output-error` — set state: output-error, errorText
- `tool-output-denied` — set state: output-denied (client declined)

**Metadata**:
- `start` — messageId?, messageMetadata?
- `finish` — finishReason?, messageMetadata?
- `message-metadata` — metadata update

**Development/Extension**:
- `data-*` — custom typed data parts (opaque JSON payload, optionally transient)
- `step-start` / `start-step` — step boundary marker

---

## Recommended Refactor Sequence

### Phase 2 Gate: AG-UI Type Surface

**Prerequisite for all downstream work**: Pin AG-UI version, decide vendor vs. depend, write canonical `Message` and `AGUIEvent` types (or use `@ag-ui/core` directly). Map bidirectional projection (UIMessage ↔ Message, UIMessageChunk ↔ AGUIEvent).

### Phase 3: Refactor agents/chat/*

**Parallelizable within this phase** (independent implementations):

1. **message-builder.ts** → rewrite `applyChunkToParts` to `applyEventToSnapshot`, consuming AGUIEvent, mutating Message snapshot
2. **sanitize.ts** → mirror logic for AG-UI Message shape
3. **tool-state.ts** → minimal change (no shape introspection); verify still works
4. **message-reconciler.ts** → rewrite for AG-UI Message ID + toolCallId semantics
5. **stream-accumulator.ts** → wrap `applyEventToSnapshot`, same metadata logic
6. **broadcast-state.ts** → refactor accumulator boundary; state machine unchanged
7. Tests for all above: run against ag-ui-shaped fixtures

**Format-agnostic, no change required** (keep as-is):
- turn-queue.ts, abort-registry.ts, continuation-state.ts, resume-stream.ts, parse-protocol.ts, lifecycle.ts, client-tools.ts, submit-concurrency.ts

### Phase 4: Rewrite AIChatAgent (packages/ai-chat/src/index.ts)

**Blocking**: Phase 2 (type surface) and Phase 3 (message-builder).

Tasks:
1. Replace `UIMessage` → `Message` type annotations throughout
2. Rewrite `_loadMessagesFromDb()` to load AG-UI Message (with v5 migration fallback)
3. Rewrite `_streamSSEReply()` to parse AG-UI SSE (AGUIEvent), apply via new `applyEventToSnapshot`
4. Rewrite persistence to write `JSON.stringify(message: Message)` to `cf_ai_chat_agent_messages`
5. Rewrite `persistMessages()`, `_sanitizeMessageForPersistence()`, `_enforceRowSizeLimit()` for Message shape
6. Update all internal message operations (toolPart finding, merging, etc.)
7. **High-risk validation**: round-trip production UIMessage rows through migrator, replay via new _reply, diff against expected AG-UI snapshot

**Migration safety**: Add schema version marker to persisted rows (e.g. `v5_uimessage` vs `v6_agui_message`) so rollback is possible.

### Phase 5: Vercel Adapter (new @cloudflare/ai-chat-vercel)

**Blocking**: Phase 2 (type surface), Phase 4 (AIChatAgent rewritten).

Tasks:
1. **Server projection**: wrap AIChatAgent's AG-UI SSE response in adapter layer that projects AGUIEvent → UIMessageChunk stream (for existing `streamText()` / `toUIMessageStreamResponse()` callers)
2. **WebSocketChatTransport**: consume AG-UI frames from agent, project to UIMessageChunk for useChat
3. **useAgentChat hook**: same public API as current `@cloudflare/ai-chat`, wraps useChat + transport
4. **One-liner migration for users**: "import from @cloudflare/ai-chat-vercel instead; wrap response in toAGUIResponse() (no-op if already AG-UI)"
5. Compatibility test suite: run existing ai-chat test suite against Vercel adapter (should stay green)

### Phase 6: TanStack Adapter (new @cloudflare/ai-chat-tanstack)

**Blocking**: Phase 2, Phase 4.

Tasks:
1. **Server SSE helper**: AIChatAgent already emits AG-UI; maybe no change needed (AG-UI is TanStack's native format)
2. **useAgentChat hook**: wrap @tanstack/ai-react's useChat, plug in AG-UI event consumer
3. **mcp/tanstack-ai tool projection**: add `getServerTools()` returning TanStack ServerTool[] (parallel to mcp/client.ts `getAITools()`)
4. TanStack example in examples/

### Phase 7: Examples + Tests

**Blocking**: Phases 3–6.

Tasks:
1. Migrate examples/playground to Vercel adapter
2. Add TanStack example
3. Regenerate test fixtures with AG-UI shapes
4. Add Vercel projection compatibility suite (transform old UIMessage snapshots, verify projections)
5. Durable execution scenarios: save UIMessage rows, load, replay, verify AG-UI shape

---

## Coupling Verdict Summary

### High-coupling files (refactor in Phase 3–4)

- **message-builder.ts**: Core chunk-to-parts logic. ~400 LOC of switch/case on chunk type. Reusable after rewrite.
- **sanitize.ts**: Provider metadata stripping, output/text truncation. ~180 LOC. Reusable after rewrite.
- **stream-accumulator.ts**: Metadata + cross-message tracking wrapper. ~180 LOC. Rewrite calls new `applyEventToSnapshot`.
- **message-reconciler.ts**: ID dedup + content-key reconciliation. ~150 LOC. Rewrite for AG-UI Message schema.
- **broadcast-state.ts**: State machine + mergeInto call. ~150 LOC. Refactor at accumulator boundary; SM unchanged.
- **ai-chat/src/index.ts**: Persistence, SSE parsing, message construction. ~4400 LOC. Rewrite all message-touching sections (~40% of file).
- **ai-chat-v5-migration.ts**: v4→v5 transformer. ~400 LOC. Keep (becomes v5→v6 for next migration).

### Cosmetic/format-agnostic files (keep as-is or minimal wrapper)

- **tool-state.ts**: State update builder. 99 LOC. Keep as-is (no shape inspection).
- **turn-queue.ts**, **abort-registry.ts**, **continuation-state.ts**, **resume-stream.ts**, **parse-protocol.ts**: Protocol and queueing plumbing. Keep as-is.
- **lifecycle.ts**: Type definitions. Keep as-is (type aliases reusable).
- **client-tools.ts**, **submit-concurrency.ts**: Tool schema + submit ordering. Keep as-is.
- **agent-tools.ts**: Reuses `applyChunkToParts` but on AgentToolRunState.parts. When message-builder is updated, this updates too (same function, different array origin).

### Thin re-exports (shim for one major)

- **ai-chat-agent.ts**, **ai-react.tsx**, **ai-types.ts**: Pure re-exports. Become deprecation shims.
- **mcp/client.ts**: `getAITools()` returns ToolSet. Keep for Vercel; add `getServerTools()` for TanStack.

---

## Risk Mitigation Checklist

- **[ ] Persistence migration**: snapshot 5–10 representative production UIMessage rows from playground/examples, round-trip through autoTransformMessages + new _reply, diff against golden AG-UI snapshots. Test rollback by schema marker.
- **[ ] Vercel adapter projection**: run full ai-chat test suite against Vercel adapter. All tests must pass unchanged.
- **[ ] Type safety**: after Phase 2 (type surface), run tsc on entire workspace with strict mode. Zero new errors.
- **[ ] SSE parsing**: before and after _streamSSEReply rewrite, run identical provider streams (Anthropic, OpenAI, Gemini) through both versions, compare part arrays bit-for-bit.
- **[ ] Tool reconciliation**: test cross-message tool-output scenarios (approval-requested in message A, output from message B). Verify behavior identical before/after.
- **[ ] Resume stream**: test stream resumption (DO restart) with active streaming message. Verify chunks replayed from SQLite, message persisted, final shape correct.

---

## Open Questions for Design Phase 2

1. **AG-UI dependency**: vendor minimal types in agents core, or depend on @ag-ui/core? → Recommend depend (cleaner, upstream updates tracked).
2. **Bi-directional projection location**: UIMessage ↔ Message converter in Vercel adapter only, or shared? → Recommend shared in adapters/ folder, reused by both server and client react layers.
3. **Resumable replay strategy**: replay raw AG-UI event log (current), or replay derived Message snapshot deltas? → Current strategy sufficient; AG-UI MESSAGES_SNAPSHOT allows snapshot-based replay in Phase 7+ optimization.
4. **Tool client schemas**: keep JSONSchema7 wire shape? → Yes. Adapters map to framework's tool type.

