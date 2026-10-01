# AG-UI canonical: one chat engine, the AI SDK layered on top

Makes AG-UI the canonical chat wire, event, and persistence format for the
Agents SDK, and reimplements `@cloudflare/ai-chat`'s `AIChatAgent` as a
projection layer over that engine. The ~6,900-line legacy chat implementation
is deleted.

Implements [`design/rfc-ag-ui-canonical.md`](./rfc-ag-ui-canonical.md) (the
why) via [`design/ag-ui-plan.md`](./ag-ui-plan.md) (the how). Addresses
[cloudflare/agents#984](https://github.com/cloudflare/agents/issues/984).

## Summary

`AGUIChatAgent` (`packages/agents/src/agui-chat-agent.ts`) is now the only
chat engine. It owns turns, persistence, streaming, recovery, transport,
tool approval, and agent-tool delegation. `AIChatAgent`
(`packages/ai-chat/src/agent.ts`) sits on top of it and keeps the AI SDK
surface intact: `onChatMessage` still returns a `UIMessageChunk` SSE
`Response`, `this.messages` is still `UIMessage[]`, and every documented
hook keeps its signature. The projections in both directions
(`chunk-to-event.ts`, `event-to-chunk.ts`, `toUIMessages`) are the whole of
the adapter.

The same inversion runs client-side: one `AGUIWebSocketTransport` in
`agents/chat` speaks the `CF_AGENT_*` envelope with AG-UI bodies, and both
the AI SDK hook and the TanStack hook are thin glue over it.
`@cloudflare/ai-chat-vercel` — a sidecar package that was never published —
is folded into `@cloudflare/ai-chat`, so no second AI SDK adapter name
enters the registry.

**Scope:** 218 files, +45,467 / −7,693 against the merge base with `main`.
Landed as a stack of eight reviewed phase PRs (#2–#9).

## Conformance evidence

The commitment this PR makes is "nothing changes downstream". That is
backed by a differential conformance harness rather than by design intent.

**How it was built.** Before any behaviour changed, Phase 0 recorded a
normalized trace of 26 scenarios run against the **then-current legacy
`AIChatAgent`**: every WebSocket frame (ids and timestamps normalized),
every persisted row at end of turn, every lifecycle hook invocation, and the
final client-visible message list. Those traces are committed as goldens in
`packages/ai-chat/src/conformance/goldens/`.

**How it is enforced.** After the swap, the same 26 scenarios run twice —
once through the package's public entry point (what users import), once
through fixtures built directly on the projection class — and both rows diff
against the goldens recorded from the deleted implementation. 60 tests
(26 scenarios × 2 stacks, plus 8 projection smoke tests), all green.

**Result: 19 of 26 scenarios are byte-identical to the legacy golden**, with
no exemptions at all: cancel mid-stream, clear history, the five
`messageConcurrency` modes, empty response body, `maxPersistedMessages`
trimming, metadata/data-parts/files/sources, multi-client broadcast, no
response, plain text, reasoning, regenerate, resume mid-stream (second
client), `saveMessages` programmatic turns, parallel tool calls, and single
tool calls.

The remaining 7 carry an allowlist file. **The allowlist does not suppress
the comparison.** The mechanism (`expectProjectedGolden` in
`conformance/harness.ts`) is:

1. The golden is **always** diffed, leaf by leaf, against the projected
   trace.
2. `goldens/<name>.allowlist.md` enumerates **JSON path patterns** — not
   whole scenarios, not whole frames — that are accepted as semantically
   equivalent, each with its justification on the same line.
3. Any difference that does not land under an enumerated path fails as
   `DIVERGENT`, naming the path and both values. A new regression inside an
   allowlisted scenario, but outside the exempted paths, still fails.
4. The full projected trace is additionally pinned as
   `goldens/<name>.projected.json`, so behaviour _inside_ the exempted paths
   is reviewable in diff and cannot drift silently either.

Scenarios reached zero divergences and held there; the loop terminated on
two consecutive clean runs.

## The 7 allowlisted equivalences

Every path pattern is enumerated in the linked file; the justifications are
summarized here.

| Scenario                   | What differs                                                                                                                                                                                                                      | Why it is equivalent                                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plaintext-response`       | The engine synthesizes a full TEXT lifecycle for a plain-text body: `[start(messageId), text-start, text-delta, text-end, done]` where legacy sent `[text-start, text-delta, text-end, done]`.                                    | Same text, same rows, same hooks, same view. The extra leading `start` carries the assistant id, which shifts normalized id slots — hence the `id` path exemptions. |
| `error-midstream`          | A mid-stream error rides the AG-UI `RUN_ERROR` event, projected to an AI SDK `error` chunk in the frame body. Legacy set envelope `error: true` with the raw error string as the body.                                            | Two paths only (`frames[3].error`, `frames[3].body`). Message, terminal done frame, hook status, and the partial `state: "streaming"` row all match exactly.        |
| `tool-approval-approve`    | The decision applies via a `cf_agent_chat_messages` snapshot instead of legacy's folded-assistant `cf_agent_message_updated`; the continuation's leading `start` now carries the assistant id.                                    | Frame granularity, not content. Part ordering inside the rows is preserved by the `partOrder` CF extension and matches the golden.                                  |
| `tool-approval-deny`       | The deny decision is broadcast as its own AG-UI `CUSTOM` mini-stream (projected to `start` + `tool-output-denied`), plus the same snapshot granularity — two extra frames, shifting later indices.                                | Frames 0–4 (the tool-call turn itself), rows, and view match the golden exactly. Only the shifted window and the id-slot swap are exempted.                         |
| `client-tool-continuation` | The client tool result applies as a standalone AG-UI tool row (snapshot + tool-row update) rather than a re-sent folded assistant — one extra frame, later indices shift. Also drops the AI SDK-only `preliminary: false` marker. | Frames 0–6, row and view content, and hook statuses all match. `preliminary` is an AI SDK-internal marker with no AG-UI representation and no rendering effect.     |
| `max-persisted-tool-pair`  | **A real user-visible change, deliberately allowlisted.** See the migration note below.                                                                                                                                           | Documented in the major changeset and the migration guide. The allowlist entry says so in capitals rather than passing it off as cosmetic.                          |
| `pre-response-throw`       | **A deliberate improvement.** See below.                                                                                                                                                                                          | Persisted user row and view content still match the golden.                                                                                                         |

Five of the seven are frame-granularity or id-slot artefacts. Two are real
behaviour changes, and both are documented rather than absorbed.

## Breaking changes (major: `@cloudflare/ai-chat` → 1.0.0)

Full detail in [`docs/agents/migration-to-agui-engine.md`](../docs/agents/migration-to-agui-engine.md);
the changeset is `.changeset/agui-cutover-major.md`. The public API is
unchanged. What breaks is storage, one frame payload, and some protected
internals.

1. **Persisted rows flip to the AG-UI shape** (`_v: "v6_agui_message"`),
   migrated automatically on first load and **one way**. `toUIMessages` (now
   exported) projects them back if you read the table directly. Activity
   messages have no `UIMessage` counterpart and are dropped on that reverse
   projection — the one documented lossy edge. Back up before upgrading a
   deployment that matters.
2. **`maxPersistedMessages` counts AG-UI rows, and tool results are separate
   rows.** A trim that used to keep `[user, assistant]` can now keep
   `[assistant, tool]` — at small limits the user's own turn drops out of
   persisted history and `/get-messages`. Budget roughly one extra row per
   expected tool call. This is the `max-persisted-tool-pair` allowlist entry.
3. **`cf_agent_message_updated` and `cf_agent_chat_messages` carry raw AG-UI
   rows**, which can have `role: "tool"` — not a valid `UIMessage` role. The
   shipped clients handle it; custom frame consumers must project via
   `autoTransformAGUIMessages` + `toUIMessages`.
4. **`this.messages` is a frozen projection.** In-place mutation
   (`this.messages.push(...)`) throws `TypeError`. Assign, or pass the new
   list to `saveMessages` / `persistMessages`.
5. **Removed protected internals, no replacement:** `_restoreActiveStream`,
   `_resolveOrphanTargetId`, `_orphanStore`, and the
   `repairInterruptedToolPart` hook. Interrupted-stream reconstruction is now
   the engine's idempotent orphan replay. Subclasses that overrode these
   should try deleting the override first.
6. **Peer dependency `agents >= 0.21.0`** — `@cloudflare/ai-chat` imports
   `agents/agui-chat-agent` and `agents/chat/agui-ws-transport`. See
   "Release-time check" below.

`agents` ships as a **minor**: `AGUIChatAgent` and the AG-UI modules are
additive.

## One intentional improvement

When `onChatMessage` throws **before** returning a `Response`, the requesting
client now receives a terminal `error: true` done frame. The legacy
implementation sent that client nothing, stranding it on a stream that would
never arrive — visible in the `pre-response-throw` golden, which contains
zero frames.

This is the only place the projected stack deliberately does something the
legacy stack did not. It is called out in the allowlist file, in the
migration guide, and here, rather than being folded in as a granularity
difference. If strict parity is preferred over the fix, the projection can
be made to reproduce the stranding instead — but shipping the hang seemed
like the wrong default.

## Release-time check before merging

The `agents >= 0.21.0` peer floor on `@cloudflare/ai-chat` and
`@cloudflare/ai-chat-tanstack` **needs confirming, and is probably too low.**
Both packages import `agents/agui-chat-agent` and
`agents/chat/agui-ws-transport`; neither module exists on `origin/main`, and
neither shipped in a published `agents@0.21.0`. The true floor is whichever
`agents` release first carries this branch. `main` has also moved to
`agents@0.22.0` and is 18 commits ahead, so this branch wants a re-merge
before the peer ranges and the changeset text are finalized.

## What this PR does not do

Two follow-ups are named in [`ag-ui-plan.md`](./ag-ui-plan.md) rather than
attempted here:

- **Migrating Think off the Vercel-shaped chat modules.** `packages/think`
  imports `agents/chat` and `agents/chat/react` at 34 sites, which is the
  only reason `message-builder`, `stream-accumulator`, `broadcast-state`,
  `sanitize`, `message-reconciler`, `repair-transcript`, `orphan-persist`,
  `orphan-store`, `wire-types`, the legacy `ws-chat-transport` and
  `chat/react.tsx` still exist. The Phase 6 sweep deleted everything whose
  last consumer was the legacy class; these survive on their own merits.
- **Cutting `@cloudflare/ai-chat`'s dependency on `agents/chat/react`.**
  `react-agui.tsx` imports and re-exports its option types and tool-part
  helpers deliberately, so the AG-UI hook's public surface cannot drift from
  the legacy hook's. That anti-drift device has done its job; it can go once
  Think is migrated.

Phase 6's original exit gate asked for `grep -r 'from "ai"'
packages/agents/src/chat/` to be empty. It was written before Phase 1 and is
unachievable: several of those imports are load-bearing for the AG-UI stack
itself (`agui-to-ui-messages` produces `UIMessage` by definition;
`lifecycle` and `client-tools` are imported by `AGUIChatAgent`). The plan now
records the original gate struck through, why it was dropped, and the
achievable gate that replaced it — no module left whose only consumer was
the deleted legacy class.

## Verification

| Gate                                                 | Result                           |
| ---------------------------------------------------- | -------------------------------- |
| `pnpm run check`                                     | green                            |
| `pnpm --filter @cloudflare/ai-chat test`             | 59 files, 877 passing, 1 skipped |
| `pnpm --filter @cloudflare/ai-chat test:conformance` | 60/60                            |
| `pnpm --filter agents test`                          | green                            |
| `pnpm --filter @cloudflare/ai-chat-tanstack test`    | 5 files, 50 passing              |
| `examples/ai-chat`, `examples/playground`            | typecheck and build clean        |

`examples/playground` deserves a note: it is the repo's kitchen-sink demo, it
was deliberately left untouched through every phase, and it needed **no
migration at all**. It extends `AIChatAgent` and calls `useAgentChat`, both
unchanged, and it builds clean on the AG-UI engine. That is the "nothing
changes downstream" claim demonstrated on real application code rather than
on fixtures.

## Docs

- [`docs/agents/chat-agents.md`](../docs/agents/chat-agents.md) — updated for
  the row format, the `maxPersistedMessages` counting change, the frozen
  `this.messages`, the raw AG-UI rows on broadcast frames, and the new
  exports.
- [`docs/agents/migration-to-agui-engine.md`](../docs/agents/migration-to-agui-engine.md)
  — new upgrade guide.
- [`examples/ai-chat/README.md`](../examples/ai-chat/README.md) — documents
  the `AGUIChatAgent`-direct variant (three server lines, none on the
  client), which replaces the deleted `examples/agui-chat-vercel`.
- [`design/ag-ui-progress.md`](./ag-ui-progress.md) — status through
  Phase 7, current test baseline, and the follow-up list.
