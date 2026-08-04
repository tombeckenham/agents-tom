# AG-UI Canonical — Branch Progress

Branch: `ag-ui-canonical` on `tombeckenham/agents-tom` (fork of `cloudflare/agents`).
RFC: [`design/rfc-ag-ui-canonical.md`](./rfc-ag-ui-canonical.md).
Upstream issue: <https://github.com/cloudflare/agents/issues/984>.

This branch is the principled inversion: AG-UI as canonical chat wire/event
format, Vercel AI SDK becomes one adapter among several. Built sidecar-style
so the existing `AIChatAgent` keeps working until cutover.

## Status snapshot

| Phase | What                                                                | Status                                                                                       |
| ----- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1     | Discovery: map UIMessage/UIMessageChunk coupling                    | ✅ Done — `design/discovery-uimessage-coupling.md`                                           |
| 2     | Discovery: AG-UI type surface                                       | ✅ Done — `design/discovery-agui-types.md`                                                   |
| 2.5   | Implement `packages/agents/src/chat/agui-types.ts`                  | ✅ Done (694 LOC, typechecks clean)                                                          |
| 3a    | Sidecar refactors: builder, sanitize, reconciler, migration         | ✅ Done (52 new tests)                                                                       |
| 3b    | Sidecar refactors: stream-accumulator, agent-tools, broadcast-state | ✅ Done                                                                                      |
| 4     | Canonical `AGUIChatAgent` class                                     | ✅ Done — `packages/agents/src/agui-chat-agent.ts` + `src/__tests__/agui-chat-agent.test.ts` |
| 5     | `@cloudflare/ai-chat-vercel` adapter package                        | ✅ Done (4 test files, 44 tests)                                                             |
| 6     | `@cloudflare/ai-chat-tanstack` adapter package                      | ✅ Done (3 test files, 17 tests) + `packages/agents/src/mcp/tanstack-ai.ts`                  |
| —     | Sync with upstream `cloudflare/agents` main                         | ✅ Done — merged 245 commits (AI SDK v7, MCP SDK v2, npm → pnpm)                             |
| 7     | Migrate examples and tests                                          | ⏸ Pending                                                                                    |

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

Plus the canonical class and the two adapter packages:

- `packages/agents/src/agui-chat-agent.ts` — the canonical `AGUIChatAgent`,
  with tests at `packages/agents/src/__tests__/agui-chat-agent.test.ts`.
- `packages/ai-chat-vercel/` — `@cloudflare/ai-chat-vercel`. Server-side
  `UIMessageChunk` ⇄ `AGUIEvent` projection plus a `WebSocketChatTransport`
  and `useAgentChat` for `@ai-sdk/react`.
- `packages/ai-chat-tanstack/` — `@cloudflare/ai-chat-tanstack`. Near-identity
  server projection plus a `useAgentChat` wrapping `@tanstack/ai-react`'s
  `useChat` through a `stream()` connection adapter.
- `packages/agents/src/mcp/tanstack-ai.ts` — `getServerTools()` off
  `MCPClientManager`, mirroring the `agents/browser/tanstack-ai.ts` pattern.

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
- **Wire body = AG-UI SSE** (camelCase JSON, exactly what `@ag-ui/encoder.encode()` produces). `CF_AGENT_*` envelope unchanged.
- **Tool approval** rides on `CUSTOM` events: `cf.agents.tool_approval.request` / `decision` / `expired`.
- **Replay** keeps the raw event log; adds an optional `MESSAGES_SNAPSHOT` prefix on reconnect for efficiency.

## Test baseline

Measured after the upstream sync:

| Suite            | Command                                                                              | Result                      |
| ---------------- | ------------------------------------------------------------------------------------ | --------------------------- |
| Chat sidecars    | `cd packages/agents && vitest run --config src/chat/__tests__/vitest.config.ts`      | 32 files, 597 tests passing |
| Agents (workers) | `cd packages/agents && vitest run --project workers`                                 | 90 files, 1745 tests        |
| Vercel adapter   | `cd packages/ai-chat-vercel && vitest run --config src/__tests__/vitest.config.ts`   | 4 files, 44 tests passing   |
| TanStack adapter | `cd packages/ai-chat-tanstack && vitest run --config src/__tests__/vitest.config.ts` | 3 files, 17 tests passing   |

Typecheck is clean across `agents`, `ai-chat`, `ai-chat-vercel` and
`ai-chat-tanstack`. Note that `agents` must be built (`pnpm --filter agents
build`) before typechecking anything that self-imports `agents`, or you get a
wall of spurious "Cannot find module" cascades.

## Environment notes

- The repo is on **pnpm** now, not npm. `agent-think` depends on a
  `pkg.pr.new` preview build that some sandboxed networks block; if
  `pnpm install` dies on it, scope the install with
  `--filter "agents..." --filter "@cloudflare/ai-chat-vercel..."` etc.
- Adapter peer ranges track upstream `@cloudflare/ai-chat`:
  `ai@^6 || ^7`, `@ai-sdk/react@^3 || ^4`, `agents@>=0.17.1 <1.0.0`. The
  TanStack adapter tracks the workspace pins: `@tanstack/ai@0.38.0`,
  `ai-react@0.16.0`, `ai-client@0.19.0`.

## Open work — next session

1. **Phase 7 — examples + tests**. Migrate `examples/playground` to the Vercel
   adapter. Add a TanStack example. Validate the legacy-row migration against
   representative fixtures.
2. **Cutover planning**. Phases 1–6 are still strictly sidecar — nothing in the
   existing `AIChatAgent` path has been modified. Decide when
   `AGUIChatAgent` becomes the default and what the deprecation window for
   `AIChatAgent` looks like.
3. **Upstream drift**. Re-merge `cloudflare/agents` main periodically; the
   surface that actually collides is small (`packages/agents/package.json`
   exports, `scripts/build.ts` entries, `src/mcp/client.ts` imports).

## Continuation prompt (paste into Claude Code on the next machine)

```
We are continuing work on the AG-UI canonical refactor of the Cloudflare
Agents SDK in this fork (branch ag-ui-canonical). Before you do anything
else, read these in order:

1. design/rfc-ag-ui-canonical.md
2. design/ag-ui-progress.md (this file you are reading)
3. design/discovery-uimessage-coupling.md (coupling map)
4. design/discovery-agui-types.md (AG-UI type surface and projection tables)

Phases 1-6 are complete and the branch has been merged up to
cloudflare/agents main (AI SDK v7, MCP SDK v2, npm -> pnpm). Everything
typechecks and every suite listed under "Test baseline" passes.

Your first job: re-establish the baseline before changing anything.

  cd /path/to/agents-tom
  git status
  pnpm install                     # see "Environment notes" if this fails
  pnpm --filter agents build       # required before any typecheck
  bun tsgo --noEmit
  cd packages/agents && vitest run --config src/chat/__tests__/vitest.config.ts

Then continue with Phase 7 - see "Open work - next session" above.

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
