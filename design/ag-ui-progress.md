# AG-UI Canonical — Branch Progress

Branch: `ag-ui-canonical` on `tombeckenham/agents-tom` (fork of `cloudflare/agents`).
RFC: [`design/rfc-ag-ui-canonical.md`](./rfc-ag-ui-canonical.md).
Upstream issue: <https://github.com/cloudflare/agents/issues/984>.

This branch is the principled inversion: AG-UI as canonical chat wire/event
format, Vercel AI SDK becomes one adapter among several. Built sidecar-style
so the existing `AIChatAgent` keeps working until cutover.

## Status snapshot

| Phase | What | Status |
|---|---|---|
| 1 | Discovery: map UIMessage/UIMessageChunk coupling | ✅ Done — `design/discovery-uimessage-coupling.md` |
| 2 | Discovery: AG-UI type surface | ✅ Done — `design/discovery-agui-types.md` |
| 2.5 | Implement `packages/agents/src/chat/agui-types.ts` | ✅ Done (694 LOC, typechecks clean) |
| 3a | Sidecar refactors: builder, sanitize, reconciler, migration | ✅ Done (52 new tests) |
| 3b | Sidecar refactors: stream-accumulator, agent-tools, broadcast-state | ✅ Done (291 chat tests passing) |
| 4 | Canonical `AGUIChatAgent` class | 🟡 **In flight when laptop closed**. File written at `packages/agents/src/agui-chat-agent.ts` (~2400 LOC). Agent had not reported completion — tests not written, verification not run. |
| 5 | `@cloudflare/ai-chat-vercel` adapter package | ⏸ Pending |
| 6 | `@cloudflare/ai-chat-tanstack` adapter package | ⏸ Pending |
| 7 | Migrate examples and tests | ⏸ Pending |

## Sidecar files landed

All under `packages/agents/src/chat/`:

- `agui-types.ts` — canonical structural types (`AGUIMessage`, `AGUIEvent`, `PERSISTED_MESSAGE_SCHEMA_VERSION = "v6_agui_message"`, CF tool-approval extension types). No runtime, no imports.
- `agui-message-builder.ts` + tests (14) — `applyEventToSnapshot`, `createInitialSnapshot`, `isReplayEvent`. Reducer over an array of `AGUIMessage`.
- `agui-sanitize.ts` + tests (10) — `sanitizeAGUIMessage`, `enforceRowSizeLimit`, `ROW_MAX_BYTES`.
- `agui-message-reconciler.ts` + tests (17) — `reconcileMessages`, `resolveToolMergeId`, `assistantContentKey`.
- `agui-migration.ts` + tests (11) — `autoTransformAGUIMessages`, `migrateUIMessageToAGUI`, `isPersistedAGUIMessage`. Schema marker: top-level `_v` field.
- `agui-stream-accumulator.ts` + tests (12) — `AGUIStreamAccumulator` class with `applyEvent`, `messages`, `pendingApprovals`, `customEvents`, `mergeInto`. Returns `AGUIChunkAction` discriminated union.
- `agui-agent-tools.ts` + tests (7) — sub-agent forwarding reducer keyed by runId.
- `agui-broadcast-state.ts` + tests (~7) — `aguiBroadcastTransition` state machine for broadcasting on new-connection joins.

Plus in flight:

- `packages/agents/src/agui-chat-agent.ts` — the canonical class (untested when committed).

## Format-agnostic primitives reused as-is

Confirmed by Phase 1 coupling map: these need no changes.

- `turn-queue.ts`
- `abort-registry.ts`
- `continuation-state.ts`
- `resumable-stream.ts`
- `submit-concurrency.ts`
- `parse-protocol.ts`
- `client-tools.ts`
- `lifecycle.ts`

## Key decisions (encoded in code and RFC)

- **Vendor structural AG-UI types** in `agents` itself (Workers-friendly, zero runtime cost); depend on `@ag-ui/core` only in adapter packages.
- **Persisted row shape = AG-UI `Message`** with top-level `_v: "v6_agui_message"` marker; legacy v5 `UIMessage` rows are detected and lazily migrated by `autoTransformAGUIMessages` on load.
- **Wire body = AG-UI SSE** (camelCase JSON, exactly what `@ag-ui/encoder.encode()` produces). CF_AGENT_* envelope unchanged.
- **Tool approval** rides on `CUSTOM` events: `cf.agents.tool_approval.request` / `decision` / `expired`.
- **Replay** keeps the raw event log; adds an optional `MESSAGES_SNAPSHOT` prefix on reconnect for efficiency.

## Test baseline

`cd packages/agents && npx vitest run --config src/chat/__tests__/vitest.config.ts`:
**18 test files, 291 tests passing.** Pre-AG-UI baseline was 210 tests in 11 files.

## Open work — next session

1. **Verify Phase 4 (`agui-chat-agent.ts`)**: run `bun tsgo --noEmit` from repo root and confirm no new type errors. If the file fails to compile, the simplest recovery is to delete it and re-spawn the Phase 4 agent (see prompt below) — the rest of the branch is independent.
2. **Write Phase 4 tests**: the agent was supposed to also write `packages/agents/src/__tests__/agui-chat-agent.test.ts`. Check whether it exists; if not, spawn a follow-up agent to write tests covering: SQL setup, persistence with `_v` marker, legacy row migration on load, `_reply` with AG-UI SSE, chat-clear/cancel/resume wire handling, tool approval CUSTOM round-trip, auto-continuation.
3. **Phase 5 — Vercel adapter** (`@cloudflare/ai-chat-vercel`). Goal: existing users flip one import and keep working. Two halves:
   - Server: helper that wraps `streamText().toUIMessageStreamResponse()` and projects `UIMessageChunk` → `AGUIEvent` SSE so `AGUIChatAgent.onChatMessage` accepts it. Use the projection tables in `discovery-agui-types.md` §§ "UIMessageChunk → AG-UI Event".
   - Client: `WebSocketChatTransport` that subscribes to AG-UI frames and projects to `UIMessageChunk` for `@ai-sdk/react`'s `useChat`. Mirror the existing `packages/ai-chat/src/ws-chat-transport.ts` structure but invert the direction. Plus a `useAgentChat` hook that preserves the current public API.
4. **Phase 6 — TanStack adapter** (`@cloudflare/ai-chat-tanstack`). Server projection is near-identity (TanStack's `chat()` already emits AG-UI). Client: `useAgentChat` wrapping `@tanstack/ai-react`'s `useChat` with a `stream()` connection adapter backed by the WS frame parser. Plus `packages/agents/src/mcp/tanstack-ai.ts` exporting `getServerTools()` from `MCPClientManager` (mirror the existing `agents/browser/tanstack-ai.ts` pattern).
5. **Phase 7 — examples + tests**. Migrate `examples/playground` to the Vercel adapter. Add a TanStack example. Validate the legacy-row migration against representative fixtures.

## Continuation prompt (paste into Claude Code on the next machine)

```
We are continuing work on the AG-UI canonical refactor of the Cloudflare
Agents SDK in this fork (branch ag-ui-canonical). Before you do anything
else, read these in order:

1. design/rfc-ag-ui-canonical.md
2. design/ag-ui-progress.md (this file you are reading)
3. design/discovery-uimessage-coupling.md (coupling map)
4. design/discovery-agui-types.md (AG-UI type surface and projection tables)

Phases 1-3 are complete (8 AG-UI sidecars under packages/agents/src/chat/
plus agui-types.ts; 291 chat tests passing). Phase 4 (the canonical
AGUIChatAgent class at packages/agents/src/agui-chat-agent.ts, ~2400 LOC)
was mid-flight when committed - the file is on disk but was never
verified or tested.

Your first job: verify Phase 4.

  cd /path/to/agents-tom
  git status
  bun tsgo --noEmit
  cd packages/agents && npx vitest run --config src/chat/__tests__/vitest.config.ts

Confirm 291 chat tests still pass. Then check whether
packages/agents/src/agui-chat-agent.ts compiles and whether
packages/agents/src/__tests__/agui-chat-agent.test.ts exists.

- If the file compiles and tests exist: run them, fix any failures.
- If the file compiles but no tests exist: spawn a backend-engineer agent
  to write tests covering: SQL setup, persistence with _v marker, legacy
  v5 row migration on load, _reply with AG-UI SSE, chat-clear/cancel/resume
  wire handling, tool approval CUSTOM round-trip, auto-continuation.
- If the file does NOT compile: delete it and re-spawn the Phase 4 agent
  using the brief from this conversation (the previous agent's prompt is
  in the git history of design/ag-ui-progress.md if you need it, but the
  shorter spec is: extend Agent directly, no `ai` package dep, use only
  agui-* primitives from packages/agents/src/chat/, sidecar to the
  existing AIChatAgent, preserve all CF_AGENT_* wire envelope handling).

Once Phase 4 is green, continue with Phase 5 (Vercel adapter package).
See `Open work — next session` in this file for the brief.

Conventions to keep:
- No `any`. No fallback code that hides errors. No comments explaining
  WHAT (only non-obvious WHY).
- Sidecar pattern: do not modify existing Vercel-shaped files until the
  cutover step.
- Use `bun tsgo --noEmit` not `bun tsc --noEmit` (per ~/.claude/CLAUDE.md).
- Spawn parallel agents for independent work; gate dependent work.
```

## Where things live

- Branch: `ag-ui-canonical` on `tombeckenham/agents-tom`
- RFC: `design/rfc-ag-ui-canonical.md`
- Discovery: `design/discovery-uimessage-coupling.md`, `design/discovery-agui-types.md`
- Types: `packages/agents/src/chat/agui-types.ts`
- Sidecar refactors: `packages/agents/src/chat/agui-*.ts` + matching `__tests__/agui-*.test.ts`
- In-flight class: `packages/agents/src/agui-chat-agent.ts`
- Upstream issue: <https://github.com/cloudflare/agents/issues/984>
