Status: proposed

# RFC: AG-UI as canonical chat protocol

## The problem

`AIChatAgent` and the shared chat toolkit (`packages/agents/src/chat/*`) are
hard-coded to Vercel AI SDK shapes (`UIMessage`, `UIMessageChunk`). That makes
the SDK look ecosystem-neutral on the cover (we ship `agents`, not
`@cloudflare/ai-sdk-agents`) but cements Vercel as the only first-class chat
client. Building "TanStack support" today means duplicating the chat lifecycle
per framework, and the same goes for CopilotKit, Mastra, LangGraph, or anyone
else.

The lifecycle work the SDK actually does — turn queueing, resumable streams,
client-tool approval round-trips, durable execution, sub-agent forwarding — is
protocol-agnostic. What we're missing is a protocol-agnostic wire format.

## The proposal

Adopt [AG-UI](https://docs.ag-ui.com) as the canonical chat wire format and
persisted message shape inside the Agents SDK. Make Vercel AI SDK an adapter on
top, alongside TanStack AI and any future AG-UI consumer.

Why AG-UI:

- It is an open standard explicitly designed as the agent ↔ UI transport.
- It is what TanStack AI's `chat()` already emits (`AGUIEvent`), what CopilotKit
  consumes, and what Mastra/LangGraph integrate with.
- Its event vocabulary (`RUN_STARTED`, `TEXT_MESSAGE_*`, `TOOL_CALL_*`,
  `TOOL_CALL_RESULT`, `STATE_SNAPSHOT/DELTA`, `MESSAGES_SNAPSHOT`, `CUSTOM`,
  `REASONING_*`, `RUN_FINISHED/ERROR`) is a strict superset of what the
  internal chat lifecycle already coordinates.
- It maps cleanly to the existing primitives: turn queue ↔ `RUN_*`, resumable
  stream ↔ replayable event log, tool-state machine ↔ `TOOL_CALL_*` +
  `TOOL_CALL_RESULT`, continuation ↔ deferred RUN within the same persisted
  message.

## What "canonical" means here

- The persisted row format in `cf_ai_chat_agent_messages` stores AG-UI
  `Message` objects (the shape AG-UI's `MessagesSnapshot` carries).
- The body of `CF_AGENT_USE_CHAT_RESPONSE` frames carries `AGUIEvent` JSON.
- `AIChatAgent.onChatMessage` returns a `Response` whose body is AG-UI SSE.
- `agents/chat/message-builder` applies `AGUIEvent` to a `Message` snapshot
  instead of applying `UIMessageChunk` to `UIMessage.parts`.
- Tool state, sanitization, reconciliation, and replay all speak AG-UI.

## Adapters (out-of-tree to the core lifecycle)

- `@cloudflare/ai-chat-vercel` — server: project `streamText()` /
  `toUIMessageStreamResponse()` output to AG-UI SSE; client:
  `WebSocketChatTransport` that consumes AG-UI frames and projects to
  `UIMessageChunk` for `@ai-sdk/react`'s `useChat`. Goal: an existing user can
  flip one import and keep their app working unchanged.
- `@cloudflare/ai-chat-tanstack` — server: identity adapter around TanStack's
  `chat()` (already AG-UI) + SSE framing; client: `useAgentChat` wrapping
  `@tanstack/ai-react`'s `useChat` with a `stream()` connection adapter on top
  of the WS frame parser; plus `mcp/tanstack-ai` for `ServerTool[]`.
- Future: `@cloudflare/ai-chat-copilotkit`, `@cloudflare/ai-chat-mastra`, etc.

The MCP tool adapter remains per-consumer (tool definitions are not part of
AG-UI). `mcp.getAITools()` stays for Vercel; we add `getServerTools()` for
TanStack-shaped `ServerTool[]`. Each adapter is ~50 LOC.

## Why this over a bridge

Considered and rejected: keep UIMessageChunk canonical, expose AG-UI as a
bridge. That ships faster but locks in the inversion: AG-UI events get
round-tripped through a strictly-poorer projection (UIMessage), losing reasoning
sub-events, state snapshots, and custom events. Every future framework adapter
inherits the lossy translation. The pragmatic path tech-debts the question we
actually want to answer.

This RFC bets on AG-UI adoption continuing to compound. If we're going to make
the inversion, doing it before users build large AIChatAgent codebases is
cheaper than doing it after.

## Migration

- New SDK reads legacy `UIMessage` rows on load and converts to AG-UI `Message`
  in `autoTransformMessages`. Writes always use AG-UI.
- The Vercel adapter exposes the same `useAgentChat` API surface from
  `@cloudflare/ai-chat-vercel/react` so user code changes one import. The
  server-side change is "wrap your existing `streamText()` response in
  `toAGUIResponse()`" — one helper call.
- Existing `@cloudflare/ai-chat` either becomes a deprecation shim re-exporting
  the Vercel adapter for one major, or is renamed.

## Non-goals

- We do not change the CF_AGENT protocol framing (request/response/resume/
  cancel/tool-result/tool-approval message types). Only the chunk body format
  changes.
- We do not change `Agent` itself, RPC, scheduling, MCP server, or any
  non-chat subsystem.
- We do not write a generic chat-UI library. AG-UI events are emitted to
  whatever consumer the user picks.

## Open questions

1. Vendor minimal AG-UI types vs depend on `@ag-ui/core`? Default: depend.
   Treat `@ag-ui/core` as a peer in adapters that need it; keep `agents` itself
   dependency-free where possible by structurally typing event shapes.
2. Where does the projection between AG-UI `Message` and `UIMessage` live for
   the Vercel adapter — server-only, client-only, or both? Likely both, with
   the same converter shared across runtime + React.
3. Resumable replay: replay raw AG-UI event log or replay derived `Message`
   snapshot deltas? Today we replay chunk bodies; AG-UI's `MESSAGES_SNAPSHOT`
   makes a snapshot-based replay strategy newly attractive.
4. Tool client schemas (`ClientToolSchema` over the wire) — AG-UI doesn't
   prescribe a tool registration format. Keep our JSONSchema7 wire shape;
   adapters map to/from their framework's tool type.

## Execution plan

Phase work, sized so each phase can be parallelized across agents:

1. **Discovery** — coupling map of every UIMessage/UIMessageChunk reference in
   `agents/chat/*` and `packages/ai-chat/*`. Output: file-level checklist.
2. **AG-UI type surface** — pin version, decide vendor-vs-depend, write the
   canonical `Message` and `AGUIEvent` types we'll use internally. Map both
   directions to `UIMessage`/`UIMessageChunk`.
3. **Refactor `agents/chat/*`** — replace `applyChunkToParts` with
   `applyEventToSnapshot`, rewrite `tool-state`, `message-reconciler`,
   `sanitize`, `parse-protocol`. Keep `TurnQueue`, `AbortRegistry`,
   `ContinuationState`, `ResumableStream` format-agnostic (verify; they likely
   already are).
4. **Rewrite `AIChatAgent`** — replace UIMessage typings, rewrite `_reply` to
   parse AG-UI SSE, persistence to write AG-UI `Message`, autoTransform to
   migrate legacy rows.
5. **Vercel adapter** — `@cloudflare/ai-chat-vercel` with server projection,
   client `WebSocketChatTransport`, and a `useAgentChat` that preserves the
   current public API.
6. **TanStack adapter** — `@cloudflare/ai-chat-tanstack` with server SSE
   helper, `useAgentChat` over `@tanstack/ai-react`, and `mcp/tanstack-ai`
   tool projection.
7. **Examples + tests** — migrate `examples/playground` to the Vercel adapter,
   add a TanStack example, port test suites, add Vercel-projection
   compatibility suite, validate the legacy-row migration with fixtures.

Each phase tracked as a task in this branch. Phases 5/6 are parallelizable
once 3/4 land. Discovery (1) and type surface (2) gate everything else.

## Risk

The persistence migration is the highest-risk single change — it touches every
existing AIChatAgent deployment that upgrades. Validation strategy: snapshot a
representative set of production-shaped UIMessage rows (from `playground` /
examples), round-trip through the migrator, replay through the new lifecycle,
diff against expected AG-UI snapshots. Land migration behind a versioned
schema marker so rollback is possible.

The Vercel adapter is the second-highest risk: the projection has to be
behavior-identical for the existing user base. Strategy: keep the current
ai-chat test suite green by running it against the Vercel adapter (same public
API, different underlying transport).
