# AG-UI Type Surface Discovery

**Phase 2 output.** Pins the AG-UI type surface we will use internally and lays
out two-way projection plans to Vercel AI SDK `UIMessage` / `UIMessageChunk`.
No code is changed in this phase.

---

## Executive summary

- **Pin `@ag-ui/core@0.0.53`.** Versioned together with `@ag-ui/encoder@0.0.53`
  and `@ag-ui/client@0.0.53`. `core` is ~1 MB unpacked, 11 files, with a single
  runtime dep on `zod`. The protocol is pre-1.0 (0.0.x) but the event surface
  has been stable across many minor releases.
- **Hybrid vendor/depend.** Vendor a minimal **structural** copy of the
  `Message` and `AGUIEvent` shapes into `packages/agents/src/chat/agui-types.ts`
  (typed objects, no Zod, no runtime cost). Depend on `@ag-ui/core` as a
  `peerDependency` only inside `@cloudflare/ai-chat-vercel`,
  `@cloudflare/ai-chat-tanstack`, and friends. Rationale: keep `agents` itself
  Worker-friendly (no Zod payload in the bundle, no semver coupling to a pre-1.0
  protocol), let adapters round-trip through the real validators if they want.
- **Persisted row shape = AG-UI `Message`.** Stored verbatim, no envelope
  beyond a schema-version marker (`v6_agui_message`) so v5 UIMessage rows can
  be detected and lazily migrated by `autoTransformMessages`.
- **Wire body = AG-UI SSE.** `CF_AGENT_USE_CHAT_RESPONSE.body` holds AG-UI
  `data: {...AGUIEvent JSON}\n\n` framing (camelCase keys, exactly what
  `@ag-ui/encoder.encode()` produces). No protobuf binding for now — JSON over
  SSE is universal, the protobuf transport is an adapter concern.
- **Replay: keep raw event log, add optional `MESSAGES_SNAPSHOT` shortcut.**
  Today `resumable-stream.ts` is format-neutral and stores opaque chunk bodies.
  Keep that. On reconnect, prefix the replay with a `MESSAGES_SNAPSHOT` synth
  from the persisted message — saves bytes and lets clients skip per-delta
  reconstruction — then replay any post-snapshot live events. Snapshot-only
  replay is rejected: it loses sub-message lifecycle (tool args streaming,
  reasoning deltas) that some clients render mid-stream.
- **Tool approval rides on `CUSTOM` with namespace `cf.agents.tool_approval`.**
  AG-UI has no approval primitive; `CUSTOM` is its escape hatch. We define
  four sub-events (`request`, `granted`, `denied`, `expired`) and document the
  schema in `design/cf-agui-extensions.md` (to be created in Phase 3).
- **Client tool schemas stay JSONSchema7.** AG-UI's `Tool` is already
  `{name, description, parameters: JSONSchema}` — our `ClientToolSchema` is a
  structural superset. No wire change. Adapters keep doing per-framework
  conversion (already do).
- **Projection is lossy in both directions in well-defined places.** Lossy
  going UIMessage → AG-UI: tool `state` distinctions like `input-streaming` vs
  `input-available` collapse onto AG-UI's event stream (state lives in events,
  not the persisted message). Lossy going AG-UI → UIMessage:
  `STATE_SNAPSHOT/DELTA`, `STEP_*`, `CUSTOM`, `RAW`, `ACTIVITY_*`, and
  encrypted reasoning have no first-class UIMessage equivalent — they map to
  `data-*` parts at best, otherwise drop. Documented per-event below.
- **The lifecycle-coordination primitives (`turn-queue`, `abort-registry`,
  `continuation-state`, `resumable-stream`, `parse-protocol`,
  `submit-concurrency`) are already format-agnostic.** Phase 3 only rewrites
  format-aware modules: `message-builder`, `sanitize`, `message-reconciler`,
  `stream-accumulator`, `broadcast-state`, plus `index.ts` in `ai-chat`.
- **A new `applyEventToSnapshot(message, event)` analogue replaces
  `applyChunkToParts`.** The reducer state shape changes from
  `MessagePart[]` (Vercel) to `Message` (AG-UI) — we accumulate an *array of
  Messages* (because TOOL_CALL_RESULT produces a separate `ToolMessage` rather
  than a part on the assistant message). Sketch in §6.

---

## AG-UI library findings

### Packages and versions (npm, current as of writing)

| Package | Version | Purpose | Runtime deps |
|---|---|---|---|
| `@ag-ui/core` | `0.0.53` | Event / Message types, Zod schemas, `EventType` enum, `Message` union | `zod ^3.22.4` |
| `@ag-ui/encoder` | `0.0.53` | `EventEncoder` — encodes events as SSE `data:` lines or protobuf binary based on `Accept` header | `@ag-ui/core`, `@ag-ui/proto` |
| `@ag-ui/client` | `0.0.53` | RxJS-based client transport, agent state, message reconstruction | `rxjs 7.8.1`, `fast-json-patch`, `untruncate-json`, `uuid`, `@ag-ui/core`, `@ag-ui/encoder`, `@ag-ui/proto` |
| `@ag-ui/proto` | `0.0.53` | protobuf wire format | (heavy; avoid) |

`core` is the only one we'd consider for the `agents` package. `client` pulls
RxJS which is a no-go in Workers without a fight. `encoder` is small but its
protobuf path drags in `@ag-ui/proto`.

### `EventType` enum (canonical, complete)

```
TEXT_MESSAGE_START | TEXT_MESSAGE_CONTENT | TEXT_MESSAGE_END
TOOL_CALL_START | TOOL_CALL_ARGS | TOOL_CALL_END | TOOL_CALL_RESULT
STATE_SNAPSHOT | STATE_DELTA | MESSAGES_SNAPSHOT
ACTIVITY_SNAPSHOT | ACTIVITY_DELTA
RAW | CUSTOM
RUN_STARTED | RUN_FINISHED | RUN_ERROR
STEP_STARTED | STEP_FINISHED
REASONING_START | REASONING_END
REASONING_MESSAGE_START | REASONING_MESSAGE_CONTENT | REASONING_MESSAGE_END
REASONING_MESSAGE_CHUNK | REASONING_ENCRYPTED_VALUE
```

### Every event variant's field shape

All events extend:

```ts
type BaseEvent = {
  type: EventType;            // discriminator
  timestamp?: number;         // ms epoch, optional
  rawEvent?: unknown;         // pre-transform original, optional
};
```

**Lifecycle**

| Event | Required fields | Optional |
|---|---|---|
| `RUN_STARTED` | `threadId: string`, `runId: string` | `parentRunId?`, `input?: RunAgentInput` |
| `RUN_FINISHED` | `threadId`, `runId` | `result?: unknown` |
| `RUN_ERROR` | `message: string` | `code?: string`, *(in some SDKs `runId?`)* |
| `STEP_STARTED` | `stepName: string` | — |
| `STEP_FINISHED` | `stepName: string` | — |

**Text messages**

| Event | Required | Optional |
|---|---|---|
| `TEXT_MESSAGE_START` | `messageId: string`, `role: "assistant"` | — |
| `TEXT_MESSAGE_CONTENT` | `messageId`, `delta: string` *(non-empty)* | — |
| `TEXT_MESSAGE_END` | `messageId` | — |

**Tool calls** (note: AG-UI splits the tool call lifecycle across the assistant
message *and* a separate `TOOL_CALL_RESULT` event whose persisted form is a
`ToolMessage`)

| Event | Required | Optional |
|---|---|---|
| `TOOL_CALL_START` | `toolCallId: string`, `toolCallName: string` | `parentMessageId?: string` |
| `TOOL_CALL_ARGS` | `toolCallId`, `delta: string` *(JSON fragment to append)* | — |
| `TOOL_CALL_END` | `toolCallId` | — |
| `TOOL_CALL_RESULT` | `messageId: string`, `toolCallId`, `content: string` | `role?: "tool"` |

**State**

| Event | Required | Optional |
|---|---|---|
| `STATE_SNAPSHOT` | `snapshot: unknown` (whole state) | — |
| `STATE_DELTA` | `delta: JSONPatchOp[]` (RFC 6902) | — |
| `MESSAGES_SNAPSHOT` | `messages: Message[]` | — |
| `ACTIVITY_SNAPSHOT` | `activity: unknown` | — *(under-specified)* |
| `ACTIVITY_DELTA` | `delta: JSONPatchOp[]` | — *(under-specified)* |

**Special**

| Event | Required | Optional |
|---|---|---|
| `RAW` | (provider-specific payload — under-specified in v0.0.53 docs) | — |
| `CUSTOM` | `name: string`, `value: unknown` | — |

**Reasoning** (block-level vs. message-level)

| Event | Required | Optional |
|---|---|---|
| `REASONING_START` | `messageId: string` | — |
| `REASONING_END` | `messageId: string` | — |
| `REASONING_MESSAGE_START` | `messageId: string`, `role: "reasoning"` | — |
| `REASONING_MESSAGE_CONTENT` | `messageId`, `delta: string` | — |
| `REASONING_MESSAGE_END` | `messageId` | — |
| `REASONING_MESSAGE_CHUNK` | `delta` *(first chunk also carries `messageId`)* | — *(client expands to START/CONTENT/END)* |
| `REASONING_ENCRYPTED_VALUE` | `subtype: "message" \| "tool-call"`, `entityId: string`, `encryptedValue: string` | — |

### Canonical `Message` shape

`Message` is a `role`-discriminated union (per AG-UI docs):

```ts
type Role =
  | "developer" | "system" | "assistant" | "user"
  | "tool" | "activity" | "reasoning";

type DeveloperMessage = { id: string; role: "developer"; content: string; name?: string };
type SystemMessage    = { id: string; role: "system";    content: string; name?: string };

type AssistantMessage = {
  id: string;
  role: "assistant";
  content?: string;             // optional if tool calls only
  name?: string;
  toolCalls?: ToolCall[];
  // (encryptedContent: string is described in concept docs; absent from
  // sdks/typescript/packages/core schemas at 0.0.53 — treat as optional)
};

type UserMessage = {
  id: string;
  role: "user";
  content: string | InputContent[];   // multimodal
  name?: string;
};

type ToolMessage = {
  id: string;
  role: "tool";
  content: string;              // tool result, typically JSON-encoded
  toolCallId: string;
  error?: string;
  encryptedValue?: string;
};

type ReasoningMessage = {
  id: string;
  role: "reasoning";
  content?: string;
  // (encrypted chain-of-thought attached separately via REASONING_ENCRYPTED_VALUE)
};

type ActivityMessage = { id: string; role: "activity"; /* under-specified */ };

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string /* JSON-encoded */ };
};

type InputContent =
  | { type: "text"; text: string }
  | { type: "image";    source: InputContentSource; metadata?: Record<string, unknown> }
  | { type: "audio";    source: InputContentSource; metadata?: Record<string, unknown> }
  | { type: "video";    source: InputContentSource; metadata?: Record<string, unknown> }
  | { type: "document"; source: InputContentSource; metadata?: Record<string, unknown> };

type InputContentSource =
  | { type: "data"; value: string; mimeType: string }   // base64 or similar
  | { type: "url";  value: string; mimeType?: string };
```

### SSE / wire format

- **Content type**: `text/event-stream` (default; `EventEncoder` can negotiate
  `application/vnd.ag-ui.event+proto` via `Accept`).
- **Framing**: each event is one `data: <json>\n\n` block. No `event:` field;
  the discriminator is `type` inside the JSON.
- **Keys**: camelCase (`messageId`, `toolCallId`).
- **Empty fields**: omitted, not nulled.
- **HTTP binding**: `POST /agent/run` (path is convention, not required) with
  body `RunAgentInput`:

```ts
type RunAgentInput = {
  threadId: string;
  runId: string;
  parentRunId?: string;
  state: unknown;
  messages: Message[];
  tools: Tool[];                // { name, description, parameters: JSONSchema }
  context: Context[];           // [{ description: string, value: string }]
  forwardedProps: unknown;
};
```

There is no separate discovery endpoint — capabilities are passed per-request.

### Ambiguities in the AG-UI spec at 0.0.53

- `RAW` event payload is under-specified; treat as `unknown`.
- `ACTIVITY_*` events appear in the enum and the discriminated union but the
  type docs do not describe their fields beyond "snapshot" / "delta".
- `AssistantMessage.encryptedContent` is described in concept docs but not in
  the published TS schema — likely landing in a near-future version.
- `RUN_ERROR.runId` is on the Kotlin and Go bindings but not the TS one. The
  Go API also includes `RunIDValue` as optional. Safe assumption: optional.
- `ToolCall.type` is `"function"` only at 0.0.53 (no other variants standardized).

---

## Vendor vs depend recommendation: **hybrid**

| Option | Pros | Cons |
|---|---|---|
| A. Depend on `@ag-ui/core` from `packages/agents` | Single source of truth, free spec updates | Pulls Zod (~50KB min) into every Workers bundle; couples our public types to a pre-1.0 SDK; semver risk; runtime validation cost on every event |
| B. Vendor structural types into `agents/chat/agui-types.ts` | Zero runtime cost; Workers-friendly; insulated from breaking 0.0.x changes; we own the types we expose publicly | Manual sync when AG-UI adds events; no built-in validators |
| **C. Hybrid (recommended)** | `agents` core stays dependency-free; adapters that *need* runtime validation or the encoder import `@ag-ui/core`/`@ag-ui/encoder` as deps; users picking an adapter accept its deps | Two declarations of the same type surface (ours and `@ag-ui/core`'s) — must be structurally compatible. Mitigated by a one-shot type-equality test in CI. |

**Recommendation: C.** Specifically:

1. `packages/agents/src/chat/agui-types.ts` — pure TS types, no Zod, no runtime.
   This is what `AIChatAgent`, `message-builder`, `sanitize`, and persistence
   speak. Public re-export from `agents/chat`.
2. `packages/agents/src/chat/agui-codec.ts` — ~50 LOC SSE encode/decode (just
   `data: ${JSON.stringify(event)}\n\n` and a line splitter; no validators).
3. `@cloudflare/ai-chat-vercel`, `@cloudflare/ai-chat-tanstack` — may depend
   on `@ag-ui/core` directly if they want Zod validation, or import the
   structural types from `agents`. Either works because the shapes match.
4. **CI guard**: a type-only test file in `packages/agents/__tests__/` that
   asserts `AGUIEvent` (ours) is assignable to `BaseEvent` (theirs) and vice
   versa per variant. Catches drift at PR time without runtime cost.

Bundle-size argument is decisive. Workers bills CPU for parsing every byte of
the deployed bundle on cold start; Zod schemas for ~25 event types plus the
Message union is non-trivial weight we'd pay on every cold start of every
chat agent. The encoder is also trivially small to reproduce — the format is
`data: ${json}\n\n` framing.

---

## Proposed canonical internal type sketches

```ts
// packages/agents/src/chat/agui-types.ts

// ============= Core enum (mirrors @ag-ui/core EventType) =============
export type AGUIEventType =
  | "TEXT_MESSAGE_START" | "TEXT_MESSAGE_CONTENT" | "TEXT_MESSAGE_END"
  | "TOOL_CALL_START"    | "TOOL_CALL_ARGS"      | "TOOL_CALL_END" | "TOOL_CALL_RESULT"
  | "STATE_SNAPSHOT"     | "STATE_DELTA"         | "MESSAGES_SNAPSHOT"
  | "ACTIVITY_SNAPSHOT"  | "ACTIVITY_DELTA"
  | "RAW" | "CUSTOM"
  | "RUN_STARTED"  | "RUN_FINISHED" | "RUN_ERROR"
  | "STEP_STARTED" | "STEP_FINISHED"
  | "REASONING_START" | "REASONING_END"
  | "REASONING_MESSAGE_START" | "REASONING_MESSAGE_CONTENT" | "REASONING_MESSAGE_END"
  | "REASONING_MESSAGE_CHUNK" | "REASONING_ENCRYPTED_VALUE";

export type BaseAGUIEvent = {
  type: AGUIEventType;
  timestamp?: number;
  rawEvent?: unknown;
};

// ============= Message union =============
export type AGUIRole =
  | "developer" | "system" | "assistant" | "user"
  | "tool" | "activity" | "reasoning";

export type AGUIToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string }; // arguments = JSON string
};

export type AGUIInputContentSource =
  | { type: "data"; value: string; mimeType: string }
  | { type: "url"; value: string; mimeType?: string };

export type AGUIInputContent =
  | { type: "text"; text: string }
  | { type: "image";    source: AGUIInputContentSource; metadata?: Record<string, unknown> }
  | { type: "audio";    source: AGUIInputContentSource; metadata?: Record<string, unknown> }
  | { type: "video";    source: AGUIInputContentSource; metadata?: Record<string, unknown> }
  | { type: "document"; source: AGUIInputContentSource; metadata?: Record<string, unknown> };

export type AGUIDeveloperMessage = { id: string; role: "developer"; content: string; name?: string };
export type AGUISystemMessage    = { id: string; role: "system";    content: string; name?: string };
export type AGUIAssistantMessage = {
  id: string;
  role: "assistant";
  content?: string;
  name?: string;
  toolCalls?: AGUIToolCall[];
};
export type AGUIUserMessage = {
  id: string;
  role: "user";
  content: string | AGUIInputContent[];
  name?: string;
};
export type AGUIToolMessage = {
  id: string;
  role: "tool";
  content: string;
  toolCallId: string;
  error?: string;
  encryptedValue?: string;
};
export type AGUIReasoningMessage = {
  id: string;
  role: "reasoning";
  content?: string;
};
export type AGUIActivityMessage = {
  id: string;
  role: "activity";
  content?: unknown;        // spec under-specified; keep open
};

export type AGUIMessage =
  | AGUIDeveloperMessage
  | AGUISystemMessage
  | AGUIAssistantMessage
  | AGUIUserMessage
  | AGUIToolMessage
  | AGUIReasoningMessage
  | AGUIActivityMessage;

// ============= Event variants =============
export type AGUIRunStartedEvent  = BaseAGUIEvent & { type: "RUN_STARTED";  threadId: string; runId: string; parentRunId?: string; input?: unknown };
export type AGUIRunFinishedEvent = BaseAGUIEvent & { type: "RUN_FINISHED"; threadId: string; runId: string; result?: unknown };
export type AGUIRunErrorEvent    = BaseAGUIEvent & { type: "RUN_ERROR";    message: string; code?: string; runId?: string };

export type AGUIStepStartedEvent  = BaseAGUIEvent & { type: "STEP_STARTED";  stepName: string };
export type AGUIStepFinishedEvent = BaseAGUIEvent & { type: "STEP_FINISHED"; stepName: string };

export type AGUITextMessageStartEvent   = BaseAGUIEvent & { type: "TEXT_MESSAGE_START";   messageId: string; role: "assistant" };
export type AGUITextMessageContentEvent = BaseAGUIEvent & { type: "TEXT_MESSAGE_CONTENT"; messageId: string; delta: string };
export type AGUITextMessageEndEvent     = BaseAGUIEvent & { type: "TEXT_MESSAGE_END";     messageId: string };

export type AGUIToolCallStartEvent  = BaseAGUIEvent & { type: "TOOL_CALL_START";  toolCallId: string; toolCallName: string; parentMessageId?: string };
export type AGUIToolCallArgsEvent   = BaseAGUIEvent & { type: "TOOL_CALL_ARGS";   toolCallId: string; delta: string };
export type AGUIToolCallEndEvent    = BaseAGUIEvent & { type: "TOOL_CALL_END";    toolCallId: string };
export type AGUIToolCallResultEvent = BaseAGUIEvent & { type: "TOOL_CALL_RESULT"; messageId: string; toolCallId: string; content: string; role?: "tool" };

export type AGUIStateSnapshotEvent    = BaseAGUIEvent & { type: "STATE_SNAPSHOT";    snapshot: unknown };
export type AGUIStateDeltaEvent       = BaseAGUIEvent & { type: "STATE_DELTA";       delta: JSONPatchOp[] };
export type AGUIMessagesSnapshotEvent = BaseAGUIEvent & { type: "MESSAGES_SNAPSHOT"; messages: AGUIMessage[] };
export type AGUIActivitySnapshotEvent = BaseAGUIEvent & { type: "ACTIVITY_SNAPSHOT"; activity: unknown };
export type AGUIActivityDeltaEvent    = BaseAGUIEvent & { type: "ACTIVITY_DELTA";    delta: JSONPatchOp[] };

export type AGUIRawEvent    = BaseAGUIEvent & { type: "RAW"; source?: string; event?: unknown };
export type AGUICustomEvent = BaseAGUIEvent & { type: "CUSTOM"; name: string; value: unknown };

export type AGUIReasoningStartEvent          = BaseAGUIEvent & { type: "REASONING_START"; messageId: string };
export type AGUIReasoningEndEvent            = BaseAGUIEvent & { type: "REASONING_END"; messageId: string };
export type AGUIReasoningMessageStartEvent   = BaseAGUIEvent & { type: "REASONING_MESSAGE_START";   messageId: string; role: "reasoning" };
export type AGUIReasoningMessageContentEvent = BaseAGUIEvent & { type: "REASONING_MESSAGE_CONTENT"; messageId: string; delta: string };
export type AGUIReasoningMessageEndEvent     = BaseAGUIEvent & { type: "REASONING_MESSAGE_END";     messageId: string };
export type AGUIReasoningMessageChunkEvent   = BaseAGUIEvent & { type: "REASONING_MESSAGE_CHUNK";   messageId?: string; delta?: string };
export type AGUIReasoningEncryptedValueEvent = BaseAGUIEvent & {
  type: "REASONING_ENCRYPTED_VALUE";
  subtype: "tool-call" | "message";
  entityId: string;
  encryptedValue: string;
};

export type JSONPatchOp =
  | { op: "add"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "replace"; path: string; value: unknown }
  | { op: "move"; from: string; path: string }
  | { op: "copy"; from: string; path: string }
  | { op: "test"; path: string; value: unknown };

export type AGUIEvent =
  | AGUIRunStartedEvent | AGUIRunFinishedEvent | AGUIRunErrorEvent
  | AGUIStepStartedEvent | AGUIStepFinishedEvent
  | AGUITextMessageStartEvent | AGUITextMessageContentEvent | AGUITextMessageEndEvent
  | AGUIToolCallStartEvent | AGUIToolCallArgsEvent | AGUIToolCallEndEvent | AGUIToolCallResultEvent
  | AGUIStateSnapshotEvent | AGUIStateDeltaEvent | AGUIMessagesSnapshotEvent
  | AGUIActivitySnapshotEvent | AGUIActivityDeltaEvent
  | AGUIRawEvent | AGUICustomEvent
  | AGUIReasoningStartEvent | AGUIReasoningEndEvent
  | AGUIReasoningMessageStartEvent | AGUIReasoningMessageContentEvent | AGUIReasoningMessageEndEvent
  | AGUIReasoningMessageChunkEvent | AGUIReasoningEncryptedValueEvent;

// ============= Cloudflare extensions (CUSTOM event payloads) =============
// Namespace: "cf.agents.*"
export type CFToolApprovalRequestValue = {
  toolCallId: string;
  toolName: string;
  input: unknown;
  approvalId: string;
  expiresAt?: number;
};
export type CFToolApprovalDecisionValue = {
  toolCallId: string;
  approvalId: string;
  approved: boolean;
  reason?: string;
};
// Encoded as: { type: "CUSTOM", name: "cf.agents.tool_approval.request", value: CFToolApprovalRequestValue }
// or          { type: "CUSTOM", name: "cf.agents.tool_approval.decision", value: CFToolApprovalDecisionValue }
```

---

## Two-way projection mapping

### 1. `AGUIMessage` ↔ `UIMessage`

#### AG-UI → UIMessage (load-time / Vercel-adapter direction)

The persisted AG-UI `Message` list contains one `AssistantMessage` *plus* zero
or more `ToolMessage`s per assistant turn. A `UIMessage` collapses these into
a single message with a heterogeneous `parts` array. The projection has to
**fold** consecutive `assistant` + `tool` messages.

| AG-UI input | UIMessage output | Notes / loss |
|---|---|---|
| `UserMessage{content:string}` | `{role:"user", parts:[{type:"text", text}]}` | Lossless |
| `UserMessage{content:InputContent[]}` | `{role:"user", parts:[...mapped]}` where `text`→`text` part, `image`→`file` part with `mediaType`+`url`, `audio`/`video`/`document` likewise | `data:` source → `file` with data URL; `metadata` field has no UIMessage slot — drop or attach to `providerMetadata` |
| `SystemMessage` | `{role:"system", parts:[{type:"text", text}]}` | Lossless |
| `DeveloperMessage` | `{role:"system", parts:[{type:"text", text}]}` | UIMessage has no `developer` role; collapse to `system` with `metadata.aguiRole="developer"` to round-trip |
| `AssistantMessage{content,toolCalls?}` (folded with following ToolMessages) | `{role:"assistant", parts:[{type:"text",text:content,state:"done"}, ...{type:`tool-${name}`,toolCallId,toolName,state,input,output}]}` | Tool part `state`: `output-available` if matching `ToolMessage` exists, else `input-available`. `arguments` (JSON string in AG-UI) → `input` (parsed object) |
| `ToolMessage` | folded into the preceding assistant's `tool-*` part as `state:"output-available", output: JSON.parse(content)` | If a `ToolMessage` arrives without a preceding assistant turn, project as a standalone tool-only assistant message with one part. The AG-UI shape allows this; UIMessage doesn't really. |
| `ReasoningMessage{content}` | append `{type:"reasoning", text:content, state:"done"}` to the next assistant turn's parts | If no following assistant, attach to a new assistant-shaped UIMessage (lossy: standalone reasoning rendered as assistant) |
| `ActivityMessage` | `{type:"data-cf.activity", data:{...}}` part on next assistant | Lossy (no UIMessage equivalent) |

**Loss summary (AG-UI → UIMessage):**
- `developer` role collapses to `system`.
- `ToolCall.id` is preserved as `toolCallId`; `ToolCall.type` ("function") is
  dropped (UIMessage assumes function).
- `ReasoningMessage.id` is dropped (UIMessage reasoning parts have no id).
- `encryptedValue` on `ToolMessage` and any `REASONING_ENCRYPTED_VALUE`
  attached out-of-band have no UIMessage slot — stash on `metadata`.
- `InputContent.metadata` lost.
- Standalone `ActivityMessage` lossy.

#### UIMessage → AG-UI (write-time / migration direction)

| UIMessage input | AG-UI output |
|---|---|
| `{role:"user", parts}` where parts is one text | `UserMessage{content:string}` |
| `{role:"user", parts}` with file/text mix | `UserMessage{content: InputContent[]}` (text → `text`, file → `image`/`audio`/`video`/`document` based on `mediaType`) |
| `{role:"system", parts:[text]}` (with `metadata.aguiRole="developer"`) | `DeveloperMessage` |
| `{role:"system", parts:[text]}` (otherwise) | `SystemMessage` |
| `{role:"assistant", parts}` | One `AssistantMessage{content?, toolCalls?}` plus one `ToolMessage` per `tool-*` part in terminal state. `content` = concat all `text` parts' `text`. Each `tool-*` part in `output-available` → `ToolMessage{content: JSON.stringify(output), toolCallId}`. Tools still in `input-streaming` / `input-available` → only as a `ToolCall` on the assistant (no result message yet) |
| `reasoning` part on assistant | Separate `ReasoningMessage{content:text}` *before* the assistant in the AG-UI list |
| `data-*` parts (cf-namespaced) | If `type === "data-cf.activity"` → `ActivityMessage`; otherwise drop or carry as `metadata.dataParts` |

**Loss summary (UIMessage → AG-UI):**
- Tool part *intermediate* `state` (`input-streaming`, `approval-requested`,
  `output-denied`, `output-error`) has no representation in the persisted
  `AGUIMessage`. State lives in the *event stream*; only terminal information
  survives in storage. To round-trip an in-flight tool we either persist the
  AG-UI event log alongside the messages (rejected — bloat) or emit a
  CUSTOM `cf.agents.tool_state` event when persisting non-terminal tools.
- `source-url` and `source-document` parts have no AG-UI equivalent — encode
  as `CUSTOM` events with `name: "cf.agents.source"`.
- `providerMetadata` on text/reasoning parts has no AG-UI slot — attach via
  `rawEvent` if present, otherwise drop.
- `step-start` part has no AG-UI message equivalent (only an event:
  `STEP_STARTED`) — drop from persisted message.

### 2. `AGUIEvent` ↔ `UIMessageChunk`

#### AG-UI Event → UIMessageChunk (Vercel-adapter projection)

| AG-UI event | UIMessageChunk | Lossy? |
|---|---|---|
| `RUN_STARTED` | `{type:"start", messageId: <derive from upcoming TEXT_MESSAGE_START>}` | Lossy: `threadId/runId` dropped; messageId arrives later — adapter must buffer |
| `RUN_FINISHED` | `{type:"finish", finishReason:"stop"}` (or pull from `result`) | Lossy: `runId`, `result.usage` if absent in our shape |
| `RUN_ERROR` | `{type:"error", errorText: message}` *(if Vercel exposes; otherwise terminate stream with an error)* | Lossy: `code`, `runId` |
| `STEP_STARTED` | `{type:"start-step"}` | Lossy: `stepName` |
| `STEP_FINISHED` | (no equivalent) | **Drop** |
| `TEXT_MESSAGE_START` | `{type:"text-start", id:messageId}` *(Vercel uses chunk `id` for the text part; messageId may be set via `start` chunk)* | Need to also emit a leading `{type:"start", messageId}` if not already |
| `TEXT_MESSAGE_CONTENT` | `{type:"text-delta", delta}` | Lossless |
| `TEXT_MESSAGE_END` | `{type:"text-end"}` | Lossless |
| `TOOL_CALL_START` | `{type:"tool-input-start", toolCallId, toolName: toolCallName}` | Lossless |
| `TOOL_CALL_ARGS` | `{type:"tool-input-delta", toolCallId, inputTextDelta: delta}` | Lossless (Vercel buffers JSON fragments the same way) |
| `TOOL_CALL_END` | `{type:"tool-input-available", toolCallId, toolName, input: JSON.parse(buffered args)}` | Adapter must buffer args until END and parse |
| `TOOL_CALL_RESULT` | `{type:"tool-output-available", toolCallId, output: JSON.parse(content)}` | Lossy on parse failure → emit `tool-output-error` |
| `STATE_SNAPSHOT` | `{type:"data-cf.state", id:"snapshot", data:snapshot}` | Lossy (data-part repurposed) |
| `STATE_DELTA` | `{type:"data-cf.state-delta", data:delta}` *(transient)* | Lossy |
| `MESSAGES_SNAPSHOT` | (no UIMessageChunk equivalent — replay primitive) | **Drop or expand to chunks** |
| `ACTIVITY_SNAPSHOT / ACTIVITY_DELTA` | `data-cf.activity` parts | Lossy |
| `RAW` | `data-cf.raw` part *(transient)* | Lossy |
| `CUSTOM` (name = `cf.agents.tool_approval.request`) | `{type:"tool-approval-request", toolCallId, approvalId}` | Lossless |
| `CUSTOM` (name = `cf.agents.tool_approval.decision`) | `{type:"tool-output-available"}` *if approved* or `{type:"tool-output-denied"}` *if not* | Lossy (`reason` dropped) |
| `CUSTOM` (other) | `data-${name}` part | Lossy |
| `REASONING_MESSAGE_START` | `{type:"reasoning-start"}` | Lossless |
| `REASONING_MESSAGE_CONTENT` | `{type:"reasoning-delta", delta}` | Lossless |
| `REASONING_MESSAGE_END` | `{type:"reasoning-end"}` | Lossless |
| `REASONING_MESSAGE_CHUNK` | expand → `reasoning-start` (first) → `reasoning-delta` → ... → `reasoning-end` (on next msgId or stream end) | Lossless after expansion |
| `REASONING_START / REASONING_END` | block markers; if no UIMessage equivalent, drop | Lossy |
| `REASONING_ENCRYPTED_VALUE` | attach to last reasoning part's `providerMetadata.aguiEncryptedValue` | Lossy if no carrier |

#### UIMessageChunk → AG-UI Event (Vercel-adapter ingest, e.g. wrapping `streamText().toUIMessageStream()`)

| UIMessageChunk | AG-UI event(s) | Lossy? |
|---|---|---|
| `{type:"start", messageId, messageMetadata}` | `RUN_STARTED{threadId,runId}` + buffer `messageId` | Lossy: `messageMetadata` → no event; carry as `CUSTOM cf.agents.message_metadata` |
| `{type:"start-step"}` / `step-start` | `STEP_STARTED{stepName:"step"}` | Lossy: stepName synthesized |
| `{type:"text-start"}` | `TEXT_MESSAGE_START{messageId, role:"assistant"}` | Lossless |
| `{type:"text-delta", delta}` | `TEXT_MESSAGE_CONTENT{messageId, delta}` | Lossless |
| `{type:"text-end"}` | `TEXT_MESSAGE_END{messageId}` | Lossless |
| `{type:"reasoning-start"}` | `REASONING_MESSAGE_START{messageId:rid, role:"reasoning"}` | Lossless |
| `{type:"reasoning-delta", delta, providerMetadata?}` | `REASONING_MESSAGE_CONTENT{messageId:rid, delta}` (+ optional `REASONING_ENCRYPTED_VALUE` if metadata contains signature) | Lossy: providerMetadata partially captured |
| `{type:"reasoning-end"}` | `REASONING_MESSAGE_END{messageId:rid}` | Lossless |
| `{type:"tool-input-start", toolCallId, toolName}` | `TOOL_CALL_START{toolCallId, toolCallName}` | Lossless |
| `{type:"tool-input-delta", inputTextDelta}` | `TOOL_CALL_ARGS{toolCallId, delta}` | Lossless |
| `{type:"tool-input-available", input}` | `TOOL_CALL_END{toolCallId}` (args buffer should already match `JSON.stringify(input)`) | Lossy: `input` re-serialization may differ byte-for-byte |
| `{type:"tool-input-error"}` | `TOOL_CALL_END` + `TOOL_CALL_RESULT{content: JSON.stringify({error}), role:"tool"}` (or `CUSTOM cf.agents.tool_error`) | Lossy |
| `{type:"tool-output-available", output, preliminary?}` | `TOOL_CALL_RESULT{messageId, toolCallId, content: JSON.stringify(output), role:"tool"}` | Lossy: `preliminary` flag must go via `CUSTOM` |
| `{type:"tool-output-error", errorText}` | `TOOL_CALL_RESULT{...content: JSON.stringify({error:errorText})}` *or* a `CUSTOM cf.agents.tool_error` | Lossy |
| `{type:"tool-approval-request", toolCallId, approvalId}` | `CUSTOM{name:"cf.agents.tool_approval.request", value:{toolCallId,approvalId,...}}` | Lossless via extension |
| `{type:"tool-output-denied"}` | `CUSTOM{name:"cf.agents.tool_approval.decision", value:{approved:false,...}}` | Lossless |
| `{type:"file", mediaType, url}` | (no AG-UI assistant-file event — embed via `CUSTOM cf.agents.file`) | Lossy |
| `{type:"source-url"}` / `source-document` | `CUSTOM cf.agents.source` | Lossy |
| `{type:"data-${name}", data, transient?}` | `CUSTOM{name:"data.${name}", value:data}` or `RAW` | Lossy |
| `{type:"finish", finishReason, messageMetadata}` | `RUN_FINISHED{threadId,runId,result:{finishReason}}` | Lossy: messageMetadata via CUSTOM |
| `{type:"message-metadata"}` | `CUSTOM cf.agents.message_metadata` | Lossy |
| `{type:"error", errorText}` | `RUN_ERROR{message:errorText}` | Lossless (modulo `code`) |

### 3. `applyEventToSnapshot` analogue

Today, `applyChunkToParts(parts: MessagePart[], chunk)` mutates a single
assistant message's `parts` array. The AG-UI analogue must:

1. Operate over **an array of messages**, not just parts (because
   `TOOL_CALL_RESULT` produces a separate `ToolMessage`).
2. Track in-flight tool calls per `toolCallId` and accumulate their
   `arguments` string across `TOOL_CALL_ARGS` deltas.
3. Track which `messageId` each text / reasoning stream belongs to.

Sketch:

```ts
export type SnapshotState = {
  messages: AGUIMessage[];
  // index for in-progress streams
  textByMsgId: Map<string, AGUIAssistantMessage>;
  reasoningByMsgId: Map<string, AGUIReasoningMessage>;
  toolArgsBuffer: Map<string, { msg: AGUIAssistantMessage; toolName: string; buf: string }>;
};

export function applyEventToSnapshot(
  state: SnapshotState,
  event: AGUIEvent
): { stateChanged: boolean; affectedMessageId?: string };
```

The `message-reconciler` rewrite then dedupes by `id` rather than by content
hash, because AG-UI gives every message an authoritative `id` from the event
stream (vs. UIMessage where the server sometimes had to generate ids late).

---

## Tool approval namespacing proposal

AG-UI offers no first-class approval primitive. Two viable carriers:

1. **`CUSTOM` events** (recommended). Decoupled from message events; future-
   proof if AG-UI later adds an approval primitive (we deprecate by renaming).
2. Riding inside `TOOL_CALL_*` somehow — no, the spec doesn't accommodate it
   and we'd be inventing fields on standard events.

### Proposed namespace: `cf.agents.tool_approval.*`

```ts
type CFToolApprovalRequestEvent = AGUICustomEvent & {
  name: "cf.agents.tool_approval.request";
  value: {
    toolCallId: string;
    toolName: string;
    input: unknown;
    approvalId: string;
    expiresAt?: number;
  };
};

type CFToolApprovalDecisionEvent = AGUICustomEvent & {
  name: "cf.agents.tool_approval.decision";
  value: {
    toolCallId: string;
    approvalId: string;
    approved: boolean;
    reason?: string;
    decidedAt?: number;
  };
};

type CFToolApprovalExpiredEvent = AGUICustomEvent & {
  name: "cf.agents.tool_approval.expired";
  value: { toolCallId: string; approvalId: string };
};
```

Persisted state: an `AssistantMessage` whose `ToolCall` is awaiting approval
carries no special marker (state lives in events). On *replay* we re-emit the
request event from the resumable-stream chunk log; the snapshot prefix tells
clients which calls are in `pending-approval` so they can render the modal
immediately without waiting.

Also: define **`cf.agents.source`**, **`cf.agents.file`**,
**`cf.agents.message_metadata`**, **`cf.agents.tool_error`**,
**`cf.agents.tool_preliminary_output`**, and **`cf.agents.state`** in the
same namespace doc (Phase 3 deliverable: `design/cf-agui-extensions.md`).
Keep the `cf.agents.*` prefix reserved so any future framework that consumes
our AG-UI feed knows which CUSTOM events are Cloudflare-specific.

---

## Replay strategy recommendation

### Today

`resumable-stream.ts` stores opaque `body` strings (each is one SSE `data:`
line worth, today a UIMessageChunk JSON). On reconnect it replays them in
order. Format-neutral — needs no changes for the protocol swap.

### Three options for AG-UI

| Strategy | Pros | Cons |
|---|---|---|
| A. Replay raw event log (current) | Lossless; clients reconstruct exact same state; minimal change | Bytes-heavy on long runs; client does full reduction; can re-trigger reasoning/tool-args animations clients may not want |
| B. Snapshot-only replay (`MESSAGES_SNAPSHOT` then live tail) | Compact; clients skip per-delta work | Loses in-flight sub-message state (current tool args buffer, current text delta); clients miss the *visual* "currently typing" affordance; STATE/CUSTOM events lost between snapshot timestamp and reconnect |
| **C. Hybrid (recommended)** | Compact for the *settled* prefix; preserves live tail; lets clients render approval prompts immediately | Slightly more replay-side logic |

**Recommended (C):** On reconnect, the agent emits

1. `RUN_STARTED{threadId, runId}` (synthetic, mirrors current run)
2. `MESSAGES_SNAPSHOT{messages: <persisted-so-far>}` (the settled prefix)
3. **Replay** every chunk after the last "settled" watermark — i.e. events
   that arrived *after* the last `TEXT_MESSAGE_END` / `TOOL_CALL_RESULT` for
   each in-flight stream. The settled watermark is computed by walking the
   chunk log backwards.
4. Live tail continues normally.

Implementation: add a `lastSettledIndex` column to
`cf_ai_chat_stream_metadata`. Updated whenever a "terminal" event is
broadcast. On replay we read it, emit the snapshot, then `SELECT body FROM
cf_ai_chat_stream_chunks WHERE chunk_index >= lastSettledIndex`.

This is **additive** to the current store — no schema break.

---

## Tool-call lifecycle mapping (existing → AG-UI)

Today's tool state machine in `chat/tool-state.ts` is keyed on `state` strings:

```
input-streaming → input-available → approval-requested → approval-responded
                                  ↘ output-available  ↘ output-available
                                  ↘ output-error
                                  ↘ output-denied
```

AG-UI's tool lifecycle is event-driven (state lives in the stream, not the
message), with terminal output stored as a `ToolMessage`. Mapping:

| Internal state | AG-UI representation |
|---|---|
| `input-streaming` | Between `TOOL_CALL_START` and `TOOL_CALL_END`; arguments accumulated via `TOOL_CALL_ARGS` deltas |
| `input-available` | After `TOOL_CALL_END` (arguments are now valid JSON); persisted on the `AssistantMessage.toolCalls` |
| `approval-requested` | `CUSTOM cf.agents.tool_approval.request` emitted; no AG-UI primitive |
| `approval-responded` (approved) | `CUSTOM cf.agents.tool_approval.decision{approved:true}` followed by tool execution; no separate state in AG-UI, just a brief window before `TOOL_CALL_RESULT` |
| `output-available` | `TOOL_CALL_RESULT{messageId,toolCallId,content:JSON.stringify(output)}` + `ToolMessage` persisted |
| `output-error` | `TOOL_CALL_RESULT{content:JSON.stringify({error})}` OR `ToolMessage{content,error}` — recommend the latter to use AG-UI's native `error` field |
| `output-denied` | `CUSTOM cf.agents.tool_approval.decision{approved:false}` — no `ToolMessage` written |
| `preliminary:true` output | `CUSTOM cf.agents.tool_preliminary_output{toolCallId,output}` between approval and final RESULT |

Gaps:
- **Approval** — solved via CUSTOM namespace above.
- **Preliminary results** (the `preliminary` flag in current tool parts) —
  solved via CUSTOM `cf.agents.tool_preliminary_output`.
- **Tool denied without explicit approval flow** — solved by the same
  approval decision CUSTOM event with `approved:false`.

`tool-state.ts` itself does no shape introspection. It can stay as-is and
operate on the new `AssistantMessage.toolCalls` array via thin adapter calls
that read/write `toolCalls[i]`. The `matchStates` arrays will need new state
strings if we keep the same internal state machine, or the machine can be
collapsed: with AG-UI as canonical, "state" is no longer a field on the
persisted message; it's a derived property of (toolCalls present? matching
ToolMessage present? pending approval CUSTOM event seen?).

**Recommendation:** keep the state machine *in memory* during a run for the
agent's own scheduling logic, but **don't persist `state`** on the message.
Derive from (toolCalls, toolMessages, approval CUSTOM events) on load.

---

## Client tool schemas (`ClientToolSchema`)

Today (`chat/client-tools.ts`):

```ts
type ClientToolSchema = {
  name: string;
  description?: string;
  parameters?: JSONSchema7;
};
```

AG-UI's `Tool` (per `RunAgentInput.tools[]`):

```ts
type Tool = {
  name: string;
  description: string;
  parameters: { type: "object"; properties: ...; required: string[] };
};
```

These are **structurally compatible**. AG-UI's `Tool` requires `description`
and an object-typed `parameters`; ours leaves both optional. We can:

- **Keep our wire shape unchanged** for client→server messages (CF_AGENT
  framing); it's a strict superset of valid input.
- **Normalize on emit** when projecting into AG-UI `RunAgentInput` for a
  downstream consumer: default `description=""`, default `parameters={type:"object",properties:{},required:[]}`.

No protocol change required. Adapters (Vercel `ToolSet`, TanStack
`ServerTool[]`) continue to translate per-framework.

---

## Open questions for the maintainer

1. **Schema-version marker placement.** Do we want `v6_agui_message` as a
   sentinel inside the JSON blob (e.g. `{"_schema":"agui.v1","message":{...}}`)
   or as a sibling SQL column? Sibling column is cheaper to query but
   schema-changes the table.
2. **Activity events.** AG-UI's `ACTIVITY_SNAPSHOT/DELTA` and `ActivityMessage`
   are under-specified. Do we adopt them at all in v1, or treat as forward-
   compat reserved types and emit `CUSTOM` events with our own activity
   namespace?
3. **`RAW` events.** Do we expose them to clients (potentially leaking
   provider internals like raw Anthropic event blobs) or strip them server-
   side before broadcast?
4. **Persisting in-flight tool arguments.** When a stream is interrupted mid
   `TOOL_CALL_ARGS`, do we persist the partial buffer (so resume can continue
   accumulating) or restart the call (re-emit `TOOL_CALL_START` from the
   provider)? Today we drop in-flight tool input on hibernation.
5. **`encryptedContent` / `encryptedValue` round-trip.** These are
   provider-specific (OpenAI Responses, Anthropic extended thinking). Should
   we persist them at all (privacy implications) or strip and let the next
   turn re-derive? Today we strip in `sanitize.ts`.
6. **`MESSAGES_SNAPSHOT` granularity on broadcast.** Do we send snapshots on
   broadcast to *all* connected clients (cheap on reconnect, expensive
   bandwidth on each message change) or only on reconnect? Recommend: only
   on reconnect; broadcast remains delta-only.
7. **CI type-equality test.** Are we OK adding `@ag-ui/core` as a
   `devDependency` of `packages/agents` purely so we can assert structural
   compatibility in tests? It would not appear in the published bundle.
8. **`developer` vs `system` role in UIMessage projection.** Vercel has no
   `developer` role. Always collapse to `system`, or stash on metadata for
   round-trip? Round-trip option is uglier but lossless.
9. **`threadId` in our wire framing.** AG-UI lifecycle events carry
   `threadId` + `runId`. Our `CF_AGENT_USE_CHAT_RESPONSE.id` is per-request.
   Do we synthesize `threadId = <agent name/id>` and `runId = request id`,
   or expose them as first-class fields on the agent?
10. **Vendor sync cadence.** With C (hybrid), how do we keep the vendored
    types in sync? Pin a script that diffs against `@ag-ui/core@latest` on a
    nightly schedule, or accept manual sync at each AG-UI minor release?

