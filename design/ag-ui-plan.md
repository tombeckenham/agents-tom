# AG-UI Cutover Plan — one engine, AI SDK layered on top

Status: proposed
Prerequisites: [`rfc-ag-ui-canonical.md`](./rfc-ag-ui-canonical.md) (the why),
[`ag-ui-progress.md`](./ag-ui-progress.md) (what the sidecar phase built).

The sidecar phase (RFC phases 1–7) deliberately duplicated every shape-aware
module so the legacy `AIChatAgent` path stayed byte-identical while the AG-UI
canonical was proven out. That duplication was always transitional. This plan
removes it: **`AGUIChatAgent` becomes the only chat engine; the AI SDK surface
(`@cloudflare/ai-chat`) is reimplemented as a projection layer on top of it;
the legacy Vercel-shaped modules are deleted.**

## End state

- ~~`packages/agents/src/chat/` contains one set of shape modules: the `agui-*`
  ones. `message-builder.ts`, `stream-accumulator.ts`, `sanitize.ts`,
  `message-reconciler.ts`, `broadcast-state.ts`, `agent-tools.ts` (chat),
  `repair-transcript.ts`, and the other Vercel-shaped chat modules are gone.~~
- ~~`grep -r 'from "ai"' packages/agents/src/chat/` returns nothing.~~
  **Both amended in Phase 7** — see "Why the original `grep` gate was
  dropped" under Phase 6. The chat directory sheds every module whose only
  consumer was the deleted legacy class; the Vercel-shaped modules that
  remain are held alive by `packages/think`, and a handful of `ai` imports
  are load-bearing for the AG-UI stack itself. Retiring the rest is a named
  follow-up, not part of this cutover.
- `AIChatAgent` in `@cloudflare/ai-chat` extends `AGUIChatAgent`. Its public
  API is unchanged (`onChatMessage` returns an AI SDK stream Response,
  `this.messages` is `UIMessage[]`, hooks keep their signatures), but every
  turn runs on the AG-UI engine via the chunk⇄event projections. Persisted
  rows are AG-UI (`_v: "v6_agui_message"`); legacy rows migrate on load
  (already implemented).
- One WebSocket transport implementation in `agents/chat` speaks the
  `CF_AGENT_*` envelope with AG-UI bodies; the Vercel and TanStack client
  layers are thin (projection pipe / identity + hook glue).
- A differential conformance harness proves the projected `AIChatAgent`
  matches the legacy one before the legacy implementation is deleted — this is
  the mechanism behind the "nothing changes downstream" commitment, replacing
  design-intent with evidence.

## Package layout decision (decide before Phase 3)

Where does the Vercel projection code live?

- **Option A (recommended):** fold `@cloudflare/ai-chat-vercel` into
  `@cloudflare/ai-chat`. One published package keeps npm continuity, existing
  users upgrade in place, and no second AI SDK adapter name enters the
  registry. `ai-chat-vercel` has never been published, so nothing breaks.
- **Option B:** publish `ai-chat-vercel` as the implementation and make
  `@cloudflare/ai-chat` a re-export shim (the RFC's original sketch).

Option A is smaller and matches "AI SDK available but layered on top". The
TanStack package ships either way. If A is chosen, drop the
`@cloudflare/ai-chat-vercel` changeset entry and delete the package at
Phase 6.

## Versioning and rollback

- The cutover is a **major** for `@cloudflare/ai-chat`: persisted rows flip to
  AG-UI shape one-way on first load. Behavior is intended-identical; storage
  is not.
- Rollback story to document (and optionally build in Phase 6): rows carry the
  `_v` marker, and `toUIMessages` can project AG-UI rows back to `UIMessage`
  — a one-shot `exportLegacyMessages()` escape hatch is cheap if reviewers
  want it. Activity messages have no `UIMessage` counterpart and are dropped
  on reverse projection; this is the one documented lossy edge.

## Phases

Each phase lists parallelizable work units (one agent each), file-level
targets, and an exit gate (a command that must pass). Later phases assume
earlier gates. Phases 1 and 2 can run concurrently. Phase 5 is a loop.

### Phase 0 — Golden capture (gates everything)

Build the differential conformance harness and record goldens from the
**current, legacy** `AIChatAgent` before anything changes.

- New workers-pool test project `packages/ai-chat/src/conformance/` (mirror
  `packages/agents/src/agui-tests/` scaffolding). A scenario driver runs each
  scenario against a DO over WS and records a normalized trace: wire frames
  (ids/timestamps normalized), persisted rows at end of turn, and the final
  client-visible message list.
- Scenario matrix (one fixture agent per family, adapted from the existing
  ai-chat suite): plain text turn · reasoning · single tool call · parallel
  tool calls · client tool + continuation · tool approval approve/deny ·
  cancel mid-stream · resume mid-stream (second client) · error mid-stream ·
  pre-Response throw · plaintext response · no response · multi-client
  broadcast · regenerate · metadata/data-parts/files/sources ·
  `maxPersistedMessages` trimming · `messageConcurrency` modes · saveMessages
  programmatic turn · clear history.
- Goldens are committed as fixtures (JSON per scenario).
- **Exit gate:** `pnpm --filter @cloudflare/ai-chat test:conformance` green
  against legacy `AIChatAgent`; goldens committed.

### Phase 1 — Feature parity in the AG-UI engine

`AGUIChatAgent` currently lacks subsystems legacy users have. Wire in the
format-agnostic primitives (they already live in `agents/chat`) and port the
corresponding ai-chat test files to `packages/agents/src/agui-tests/`.
Five independent work units:

- **1a** `ChatRecoveryEngine` + incident/terminal records (`chatRecovery`
  currently only wraps `runFiber`; add retry budgets, give-up terminal
  banner, durable terminal record). Port `durable-chat-recovery` /
  `chat-recovery` scenarios.
- **1b** `ResumeHandshake` — terminal replay to reconnecting clients.
- **1c** `PreStreamTurns` settling (the #1784 pre-stream race).
- **1d** `StallWatchdog` + stream progress/credit throttles.
- **1e** `AutoContinuationController` (replace the simplified coalesce
  constant).

**Exit gate:** ported suites green; `pnpm --filter agents test` green.

### Phase 2 — Transport consolidation (parallel with Phase 1)

- Extract one `AGUIWebSocketTransport` into
  `packages/agents/src/chat/agui-ws-transport.ts`, generalizing the TanStack
  adapter's transport. Collapse the three near-identical stream builders
  (request / resume / tool-continuation) into one parameterized
  queue/waiter/finish/drain implementation.
- `ai-chat-tanstack/src/ws-chat-transport.ts` → re-export + thin glue.
- `ai-chat-vercel/src/ws-chat-transport.ts` → the shared transport piped
  through `event-to-chunk` / `chunk-to-event`.
- **Exit gate:** both adapter suites pass unchanged
  (`pnpm --filter @cloudflare/ai-chat-tanstack --filter @cloudflare/ai-chat-vercel test`
  — currently 50 + 85 tests).

### Phase 3 — Server-side AI SDK layer

Reimplement `AIChatAgent` as a projection layer, in a new file beside the
legacy one (`packages/ai-chat/src/agent.ts`), leaving `index.ts` untouched
until Phase 5 so the harness can run both.

- `class AIChatAgent extends AGUIChatAgent`. `onChatMessage` keeps its AI SDK
  signature; the returned `UIMessageChunk` SSE Response is piped through the
  server-side `chunk-to-event` projection before the AG-UI `_reply` consumes
  it.
- `this.messages`: getter projecting AG-UI rows via `toUIMessages`; writes
  (`saveMessages`, setter) accept `UIMessage[]` and run
  `migrateUIMessageToAGUI`.
- Hook results (`onChatResponse` etc.) projected back to legacy shapes.
- `getInitialMessages`, request-context, client-tool schemas: delegate, no
  reimplementation.
- **Exit gate:** typecheck + a smoke test file driving one turn end-to-end
  through the new class.

### Phase 4 — Client-side AI SDK layer

- `@cloudflare/ai-chat/react`'s `useAgentChat` re-based on the shared
  transport (Phase 2) + `event-to-chunk`, absorbing the ai-chat-vercel React
  hook. Public API unchanged.
- Keep the legacy client in place until Phase 5 (same sidecar rule as
  Phase 3).
- **Exit gate:** `pnpm --filter @cloudflare/ai-chat run test:react` green
  against the new client wired to the new server class.

### Phase 5 — Differential cutover (the loop)

1. Run the Phase 0 harness against the projected stack (Phase 3 server +
   Phase 4 client). Diff every scenario against the goldens.
2. Classify each mismatch: **divergent** (fix the projection or engine) or
   **semantically equivalent** (frame granularity, chunk boundary timing —
   allowlist with a one-line justification committed next to the golden).
3. Loop until zero divergent scenarios.
4. Swap: `packages/ai-chat/src/index.ts` re-exports the projected
   implementation; delete the legacy class body (~6,900 lines).
5. Run the **entire existing ai-chat suite** against the swapped
   implementation — this was the RFC's own success criterion. Fix until
   green; every fix loops back through step 1.

- **Exit gate:** full ai-chat suite + conformance suite + full repo
  (`pnpm test && pnpm run check`) green with the legacy implementation
  deleted.

### Phase 6 — Deletion and dependency cleanup

- Delete legacy shape modules in `agents/chat` bottom-up, driven by an
  importer check (`grep -rl 'from "\./message-builder"' …` etc. — delete only
  files with zero remaining importers, repeat until fixpoint). Expected:
  `message-builder`, `stream-accumulator`, `sanitize`, `message-reconciler`,
  `broadcast-state`, `agent-tools`, `repair-transcript`, `orphan-persist`,
  `orphan-store`, `wire-types`, legacy `ws-chat-transport`.
- Remove `ai` imports from `agents/chat`; `ai` stays a peer of
  `@cloudflare/ai-chat` only (its public API is the AI SDK).
- Execute the package-layout decision (fold or publish `ai-chat-vercel`).
- Rewrite changesets: `@cloudflare/ai-chat` major with migration notes;
  `agents` minor.
- ~~**Exit gate:** `grep -r 'from "ai"' packages/agents/src/chat/` empty;
  `pnpm test && pnpm run check` green; `changeset status` correct.~~
  **Amended in Phase 7 — the `grep` clause was unachievable as written.**
  See below.
- **Exit gate (amended):** the importer-driven sweep reaches fixpoint with no
  module left in `packages/agents/src/chat/` whose only consumer was the
  deleted legacy `AIChatAgent`; `pnpm test && pnpm run check` green;
  `changeset status` correct.

#### Why the original `grep` gate was dropped

Written before Phase 1, the gate assumed every `from "ai"` import under
`packages/agents/src/chat/` belonged to the legacy Vercel path. Two things
falsify that, both discovered while executing the phase:

1. **Several `ai` imports are load-bearing for the AG-UI stack itself.**
   `agui-to-ui-messages.ts` produces `UIMessage` by definition — importing
   the type is the whole point of the module. `lifecycle.ts` and
   `client-tools.ts` are imported directly by `AGUIChatAgent`
   (`packages/agents/src/agui-chat-agent.ts`). And `broadcast-state.ts` —
   which pulls in `stream-accumulator.ts` and `message-builder.ts` — backs
   the live cross-tab observer path that `packages/ai-chat/src/react-agui.tsx`
   reaches through `agents/chat/react`. Deleting these would delete the
   engine, not the legacy layer.
2. **`agents/chat/react` is not Think-only.** `react-agui.tsx` imports
   `UseAgentChatOptions`, `extractClientToolSchemas` and the tool-part
   helpers from it, and re-exports them rather than redeclaring them,
   deliberately — it is the mechanism that stops the AG-UI hook's public
   surface from drifting away from the legacy hook's.

What Phase 6 could and did achieve is the fixpoint sweep: every module whose
last production consumer was the deleted class is gone (`agui-broadcast-state`,
`isReplayChunk`, `reconcileOrphanPartial`, the dead barrel aliases). The
Vercel-shaped modules that remain are alive because `packages/think` imports
`agents/chat` and `agents/chat/react` (34 import sites), not because the
cutover missed them.

#### Follow-ups this defers (not blockers for this PR)

- **Migrate Think off the Vercel-shaped chat modules.** `packages/think` is
  now the sole reason `message-builder`, `stream-accumulator`,
  `broadcast-state`, `sanitize`, `message-reconciler`, `repair-transcript`,
  `orphan-persist`, `orphan-store`, `wire-types`, the legacy
  `ws-chat-transport` and `chat/react.tsx` survive. Porting Think to the
  AG-UI engine retires all of them in one sweep, and only then does an
  `ai`-free `agents/chat` become meaningful.
- **Cut `@cloudflare/ai-chat`'s dependency on `agents/chat/react`.** The
  re-export coupling in `react-agui.tsx` was an anti-drift device for the
  cutover, and it has served that purpose. Once Think is migrated, move the
  option types and tool-part helpers into `@cloudflare/ai-chat` and let
  `agents/chat/react` go with the rest.

### Phase 7 — Examples, docs, PR

- Migrate `examples/playground` (deliberately deferred by the sidecar rule).
- Fold `examples/agui-chat-vercel` into the main `ai-chat` example if
  Option A was chosen.
- Update `docs/agents/chat-agents.md` and the migration doc.
- Refresh `ag-ui-progress.md` status table; write the PR description:
  summary, conformance evidence, allowlisted equivalences, the major-version
  migration note, and the one known intentional improvement (pre-Response
  throw now emits a terminal error frame — upstreamable to legacy as part of
  Phase 3 if strict parity is preferred).

## Orchestration notes (loop / agent team)

- **Dependency graph:** 0 → {1a…1e, 2 in parallel} → 3 → 4 → 5 (loop) → 6 → 7.
- Every work unit is scoped to named files and carries a runnable gate, so an
  agent can verify its own work without global context. Agents must not touch
  legacy Vercel-shaped files before Phase 5 step 4 (the sidecar rule still
  holds until the swap).
- Phase 5 is the natural loop body: run harness → pick one divergent
  scenario → fix → rerun. Terminate on zero divergences twice consecutively.
- The riskiest units are 1a (recovery engine wiring) and 3 (the shim);
  everything else is mechanical. Budget review time accordingly.
