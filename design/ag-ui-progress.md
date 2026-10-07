# AG-UI Canonical — Branch Progress

Branch: `ag-ui-canonical` on `tombeckenham/agents-tom` (fork of `cloudflare/agents`).
RFC: [`design/rfc-ag-ui-canonical.md`](./rfc-ag-ui-canonical.md).
Upstream issue: <https://github.com/cloudflare/agents/issues/984>.

This branch is the principled inversion: AG-UI as canonical chat wire/event
format, Vercel AI SDK becomes one adapter among several.

The work ran in two stages. The **sidecar phase** built the AG-UI canonical
alongside the legacy `AIChatAgent`, touching nothing it owned. The **cutover
phase** ([`ag-ui-plan.md`](./ag-ui-plan.md)) made the AG-UI engine the only
engine and deleted the legacy implementation, gated throughout by a
differential conformance harness. Both are complete.

## Status snapshot — cutover phase (`ag-ui-plan.md`)

| Phase | What                                                     | Status                                                                                               |
| ----- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 0     | Golden capture — differential conformance harness        | ✅ Done — `packages/ai-chat/src/conformance/`, 26 scenarios recorded from the legacy class           |
| 1     | Feature parity in the AG-UI engine (1a–1e)               | ✅ Done — recovery engine, resume handshake, pre-stream settling, stall watchdog, auto-continuation  |
| 2     | Transport consolidation                                  | ✅ Done — one `AGUIWebSocketTransport`; adapters became thin glue                                    |
| 3     | Server-side AI SDK layer (`AIChatAgent` as a projection) | ✅ Done — `packages/ai-chat/src/agent.ts`                                                            |
| 3b    | Agent-tool child adapter in `AGUIChatAgent`              | ✅ Done                                                                                              |
| 4     | Client-side AI SDK layer                                 | ✅ Done — `useAgentChat` rebased on the shared transport                                             |
| 5     | Differential cutover (the loop)                          | ✅ Done — zero divergent scenarios; the 6,915-line legacy class deleted; full legacy suite green     |
| 6     | Deletion and dependency cleanup                          | ✅ Done — importer sweep to fixpoint; `ai-chat-vercel` folded into `@cloudflare/ai-chat`; changesets |
| 7     | Examples, docs, PR                                       | ✅ Done — this document, the docs updates, and `design/ag-ui-cutover-pr.md`                          |

Phase 6's original exit gate (`grep -r 'from "ai"' packages/agents/src/chat/`
empty) was amended in Phase 7 — it was unachievable as written, and the plan
now records why plus the two follow-ups it defers. See
[`ag-ui-plan.md`](./ag-ui-plan.md#phase-6--deletion-and-dependency-cleanup).

## Status snapshot — sidecar phase (RFC phases 1–7)

| Phase | What                                                                | Status                                                                                       |
| ----- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1     | Discovery: map UIMessage/UIMessageChunk coupling                    | ✅ Done — `design/discovery-uimessage-coupling.md`                                           |
| 2     | Discovery: AG-UI type surface                                       | ✅ Done — `design/discovery-agui-types.md`                                                   |
| 2.5   | Implement `packages/agents/src/chat/agui-types.ts`                  | ✅ Done (694 LOC, typechecks clean)                                                          |
| 3a    | Sidecar refactors: builder, sanitize, reconciler, migration         | ✅ Done (52 new tests)                                                                       |
| 3b    | Sidecar refactors: stream-accumulator, agent-tools, broadcast-state | ✅ Done                                                                                      |
| 4     | Canonical `AGUIChatAgent` class                                     | ✅ Done — `packages/agents/src/agui-chat-agent.ts` + `src/__tests__/agui-chat-agent.test.ts` |
| 5     | `@cloudflare/ai-chat-vercel` adapter package                        | ✅ Done — folded into `@cloudflare/ai-chat` at cutover Phase 6                               |
| 6     | `@cloudflare/ai-chat-tanstack` adapter package                      | ✅ Done (3 test files, 17 tests) + `packages/agents/src/mcp/tanstack-ai.ts`                  |
| —     | Sync with upstream `cloudflare/agents` main                         | ✅ Done — merged 245 commits (AI SDK v7, MCP SDK v2, npm → pnpm)                             |
| 7     | Examples + migration fixtures                                       | ✅ Done — plus `toUIMessages` / `toModelMessages` and fixture tests                          |

## Sidecar files landed

All under `packages/agents/src/chat/`:

- `agui-types.ts` — canonical structural types (`AGUIMessage`, `AGUIEvent`, `PERSISTED_MESSAGE_SCHEMA_VERSION = "v6_agui_message"`, CF tool-approval extension types). No runtime, no imports.
- `agui-message-builder.ts` + tests (14) — `applyEventToSnapshot`, `createInitialSnapshot`, `isReplayEvent`. Reducer over an array of `AGUIMessage`.
- `agui-sanitize.ts` + tests (10) — `sanitizeAGUIMessage`, `enforceRowSizeLimit`, `ROW_MAX_BYTES`.
- `agui-message-reconciler.ts` + tests (17) — `reconcileMessages`, `resolveToolMergeId`, `assistantContentKey`.
- `agui-migration.ts` + tests (11) — `autoTransformAGUIMessages`, `migrateUIMessageToAGUI`, `isPersistedAGUIMessage`. Schema marker: top-level `_v` field.
- `agui-stream-accumulator.ts` + tests (12) — `AGUIStreamAccumulator` class with `applyEvent`, `messages`, `pendingApprovals`, `customEvents`, `mergeInto`. Returns `AGUIChunkAction` discriminated union.
- `agui-agent-tools.ts` + tests (7) — sub-agent forwarding reducer keyed by runId.
- ~~`agui-broadcast-state.ts` + tests (~7) — `aguiBroadcastTransition` state machine for broadcasting on new-connection joins.~~ **Deleted at cutover Phase 6**: it had zero production importers once the AG-UI broadcast path settled on projecting events to chunks and reusing `broadcast-state`.

Plus the canonical class and the adapter packages:

- `packages/agents/src/agui-chat-agent.ts` — the canonical `AGUIChatAgent`,
  with tests at `packages/agents/src/__tests__/agui-chat-agent.test.ts`.
- ~~`packages/ai-chat-vercel/` — `@cloudflare/ai-chat-vercel`.~~ **Folded into
  `@cloudflare/ai-chat` at cutover Phase 6** and the package deleted; it was
  never published. The server-side `UIMessageChunk` ⇄ `AGUIEvent` projection
  now lives at `packages/ai-chat/src/{chunk-to-event,event-to-chunk}.ts`, and
  the transport plus `useAgentChat` for `@ai-sdk/react` at
  `packages/ai-chat/src/{ws-chat-transport,react-agui}.tsx`.
- `packages/ai-chat-tanstack/` — `@cloudflare/ai-chat-tanstack`. Near-identity
  server projection plus a `useAgentChat` wrapping `@tanstack/ai-react`'s
  `useChat` through a `stream()` connection adapter.
- `packages/agents/src/mcp/tanstack-ai.ts` — `getServerTools()` off
  `MCPClientManager`, mirroring the `agents/browser/tanstack-ai.ts` pattern.

## Inbound message projections

Phase 7 surfaced a gap: `AGUIChatAgent.messages` is canonical AG-UI, but
every adapter needs it in its own provider's input shape before it can call
a model. Each adapter now owns that projection, and the asymmetry between
them is the clearest evidence for the RFC's central claim.

- The AI SDK path (then `@cloudflare/ai-chat-vercel`, now
  `@cloudflare/ai-chat`) → `toUIMessages(messages)`. Has real work to
  do: AG-UI keeps tool results as standalone `role: "tool"` messages, while
  `UIMessage` folds them onto the tool part of the assistant turn that
  issued the call, matched by `toolCallId`.
- `@cloudflare/ai-chat-tanstack` → `toModelMessages(messages)`. A field
  rename and a role fold. TanStack's `ModelMessage` already carries
  `role` / `content` / `toolCalls` / `toolCallId` with AG-UI's meanings, and
  its `ContentPart` union is structurally identical to `AGUIInputContent`
  apart from the text variant's field name.

## Examples

- `examples/ai-chat` — the flagship example, unchanged across the cutover:
  it extends `AIChatAgent` and now runs on the AG-UI engine underneath. Its
  README documents the `AGUIChatAgent`-direct variant (three server lines,
  none on the client) that `examples/agui-chat-vercel` used to carry as a
  whole package; that example was deleted at Phase 7.
- `examples/agui-chat-tanstack` — the same agent via `@tanstack/ai`, where
  the server-side projection disappears entirely.
- `examples/playground` — deliberately untouched throughout the sidecar
  phase, and it needed no migration at cutover either: it uses only the
  unchanged `AIChatAgent` / `useAgentChat` surface, and typechecks and
  builds clean against the AG-UI engine. That is itself the evidence the
  projection holds for existing code.

All typecheck. The AG-UI examples still have not been run end-to-end: they
need a Workers AI binding.

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

Measured at the end of Phase 7, on this branch:

| Suite            | Command                                              | Result                                                |
| ---------------- | ---------------------------------------------------- | ----------------------------------------------------- |
| ai-chat          | `pnpm --filter @cloudflare/ai-chat test`             | 59 files, 877 passing, 1 skipped                      |
| Conformance      | `pnpm --filter @cloudflare/ai-chat test:conformance` | 2 files, 60 passing (26 scenarios × 2 stacks + smoke) |
| agents           | `pnpm --filter agents test`                          | green                                                 |
| TanStack adapter | `pnpm --filter @cloudflare/ai-chat-tanstack test`    | 5 files, 50 passing                                   |
| Repo check       | `pnpm run check`                                     | green                                                 |

`pnpm run build` must run before any typecheck — anything that self-imports a
workspace package resolves through its `dist`, and a stale or missing `dist`
produces a wall of spurious "Cannot find module" cascades. This has produced
false results on this branch more than once.

## Environment notes

- The repo is on **pnpm** now, not npm. `agent-think` depends on a
  `pkg.pr.new` preview build that some sandboxed networks block; if
  `pnpm install` dies on it, scope the install with
  `--filter "agents..." --filter "@cloudflare/ai-chat..."` etc.
- Peer ranges: `@cloudflare/ai-chat` is `ai@^6 || ^7`,
  `@ai-sdk/react@^3 || ^4`, `agents@>=0.21.0 <1.0.0`;
  `@cloudflare/ai-chat-tanstack` matches the `agents` floor.
  **That floor still needs a release-time check.** Both packages import
  `agents/agui-chat-agent` and `agents/chat/agui-ws-transport`, which do not
  exist on `origin/main` and were never published in `agents@0.21.0` — the
  real floor is whatever version of `agents` first ships this branch. Fix
  both peer ranges (and the `agui-cutover-major` changeset text) once the
  merge order is known.
- The TanStack adapter is on the latest published TanStack AI:
  `@tanstack/ai@0.42.0`, `ai-react@0.18.1`, `ai-client@0.22.1`. The rest of
  the workspace (`agents`, `codemode`, `experimental/tanstack-recovery`) is
  still pinned to `@tanstack/ai@0.38.0`, so the tree carries two copies.
  This is benign today — `ServerTool`, the only type crossing the boundary
  (`agents/mcp/tanstack-ai.ts` re-exports it), is identical in both, and
  the adapter itself only consumes `ai-react` / `ai-client`, which nothing
  else in the workspace uses. Worth collapsing to one version the next time
  upstream moves its own pin.

## Open work — after this PR

1. **Migrate Think off the Vercel-shaped chat modules.** `packages/think` is
   now the sole reason `message-builder`, `stream-accumulator`,
   `broadcast-state`, `sanitize`, `message-reconciler`, `repair-transcript`,
   `orphan-persist`, `orphan-store`, `wire-types`, the legacy
   `ws-chat-transport` and `chat/react.tsx` still exist (34 import sites
   across `agents/chat` and `agents/chat/react`). Porting Think to the AG-UI
   engine retires all of them at once.
2. **Cut `@cloudflare/ai-chat`'s dependency on `agents/chat/react`.**
   `react-agui.tsx` imports and re-exports the option types and tool-part
   helpers deliberately, as an anti-drift device for the cutover. Once Think
   is migrated, move them into `@cloudflare/ai-chat`.
3. **Run the examples for real.** `examples/agui-chat-tanstack` and the
   `AGUIChatAgent` variant documented in `examples/ai-chat` typecheck but
   have not been executed — they need a Workers AI binding. The end-to-end
   claim for those paths rests on unit and conformance tests alone.
   (`examples/ai-chat` and `examples/playground` build clean.)
4. **Upstream drift**. Re-merge `cloudflare/agents` main periodically; the
   surface that actually collides is small (`packages/agents/package.json`
   exports, `scripts/build.ts` entries, `src/mcp/client.ts` imports).

## Picking this up again

Read in order: [`rfc-ag-ui-canonical.md`](./rfc-ag-ui-canonical.md) (the
why), [`ag-ui-plan.md`](./ag-ui-plan.md) (the cutover, including the amended
Phase 6 gate), this file (where things landed), and
[`ag-ui-cutover-pr.md`](./ag-ui-cutover-pr.md) (the evidence). The coupling
map and type surface are in
[`discovery-uimessage-coupling.md`](./discovery-uimessage-coupling.md) and
[`discovery-agui-types.md`](./discovery-agui-types.md).

Re-establish the baseline before changing anything. `agents`, `ai-chat`,
`codemode` and `voice` must be built before typechecking anything that
self-imports them, or you get a wall of spurious "Cannot find module"
cascades — stale dists have produced false results on this branch repeatedly:

```sh
pnpm install                # see "Environment notes" if this fails
pnpm run build
pnpm run check
pnpm --filter @cloudflare/ai-chat test
pnpm --filter @cloudflare/ai-chat run test:conformance
pnpm --filter agents test
```

Conventions to keep: no `any`; no fallback code that hides errors; comments
explain non-obvious WHY, never WHAT. The sidecar rule is retired — there is
one engine now, and the legacy Vercel-shaped modules that remain belong to
Think (see "Open work" above).

## Where things live

- Branch: `ag-ui-canonical` on `tombeckenham/agents-tom`
- RFC: `design/rfc-ag-ui-canonical.md`
- Cutover plan: `design/ag-ui-plan.md`; PR description: `design/ag-ui-cutover-pr.md`
- Discovery: `design/discovery-uimessage-coupling.md`, `design/discovery-agui-types.md`
- Types: `packages/agents/src/chat/agui-types.ts`
- AG-UI modules: `packages/agents/src/chat/agui-*.ts` + matching `__tests__/agui-*.test.ts`
- The engine: `packages/agents/src/agui-chat-agent.ts`
- The AI SDK projection: `packages/ai-chat/src/agent.ts`, `react-agui.tsx`, `chunk-to-event.ts`, `event-to-chunk.ts`
- Conformance harness and goldens: `packages/ai-chat/src/conformance/`
- User docs: `docs/agents/chat-agents.md`, `docs/agents/migration-to-agui-engine.md`
- Upstream issue: <https://github.com/cloudflare/agents/issues/984>
