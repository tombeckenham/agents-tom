/**
 * AG-UI sidecar reducer for sub-agent tool forwarding. Mirrors the contract
 * of `agent-tools.ts` (Vercel-shaped) but applies `AGUIEvent` JSON bodies via
 * `applyEventToSnapshot` instead of `UIMessageChunk` bodies via
 * `applyChunkToParts`.
 *
 * Used when an `AIChatAgent` calls another `AIChatAgent` as a tool and the
 * child's `CF_AGENT_USE_CHAT_RESPONSE` frames are forwarded onto the parent's
 * stream: the parent groups frames by `parentToolCallId`, fans them into one
 * per-run snapshot, and exposes the assembled `AGUIMessage[]` for UI render.
 */

import {
  applyEventToSnapshot,
  createInitialSnapshot,
  type SnapshotState
} from "./agui-message-builder";
import type { AGUIEvent, AGUIMessage } from "./agui-types";

// ============================================================================
// Public types
// ============================================================================

/**
 * One forwarded frame from a child agent's stream. `body` is the JSON-encoded
 * `AGUIEvent` that rode on the child's `CF_AGENT_USE_CHAT_RESPONSE`. Parent
 * agents tag each forwarded frame with the originating `runId`, the
 * `parentToolCallId` that scoped the sub-call, a monotonic `sequence` (used
 * to drop reordered duplicates from DO replication), and optionally a
 * `terminal` marker that closes the run.
 */
export type AGUIAgentToolEvent = {
  runId: string;
  parentToolCallId?: string;
  body: string;
  sequence: number;
  terminal?: "completed" | "error" | "aborted";
  error?: string;
};

/**
 * Per-run lifecycle state. `state` starts at `"running"` and transitions once
 * to a terminal value when an `AGUIAgentToolEvent` carrying `terminal` is
 * applied. `error` carries the failure detail when `state === "error"`.
 */
export type AGUIAgentToolRunState = {
  runId: string;
  parentToolCallId?: string;
  snapshot: SnapshotState;
  state: "running" | "completed" | "error" | "aborted";
  error?: string;
  lastSequence: number;
};

/**
 * Reducer state: every observed run plus an insertion-ordered run id list so
 * the parent can render runs deterministically. `orderedRunIds` is exposed
 * `readonly` to discourage callers from mutating ordering directly.
 */
export type AGUIAgentToolEventState = {
  runs: Map<string, AGUIAgentToolRunState>;
  orderedRunIds: readonly string[];
};

/**
 * The projection a UI consumer renders: one entry per run, in display order.
 */
export type AGUIAgentToolEventMessage = {
  runId: string;
  parentToolCallId?: string;
  messages: AGUIMessage[];
  state: "running" | "completed" | "error" | "aborted";
  error?: string;
  lastSequence: number;
};

// ============================================================================
// Reducer
// ============================================================================

export function createAGUIAgentToolEventState(): AGUIAgentToolEventState {
  return {
    runs: new Map(),
    orderedRunIds: []
  };
}

/**
 * Get-or-create the per-run state, apply the parsed AGUIEvent (if the body
 * parses), update lifecycle on `terminal`, and bump `lastSequence`. Mutates
 * `state` in place. Out-of-order events (sequence going backwards) are
 * dropped silently — DO replication can reorder frames. Late events after a
 * terminal are dropped, mirroring `agent-tools.ts`.
 */
export function applyAGUIAgentToolEvent(
  state: AGUIAgentToolEventState,
  event: AGUIAgentToolEvent
): void {
  let run = state.runs.get(event.runId);
  if (!run) {
    run = {
      runId: event.runId,
      parentToolCallId: event.parentToolCallId,
      snapshot: createInitialSnapshot(),
      state: "running",
      lastSequence: -1
    };
    state.runs.set(event.runId, run);
    state.orderedRunIds = [...state.orderedRunIds, event.runId];
  }

  if (event.sequence < run.lastSequence) {
    return;
  }
  run.lastSequence = event.sequence;

  if (run.state !== "running") {
    return;
  }

  if (event.body.length > 0) {
    const parsed = tryParseAGUIEvent(event.body);
    if (parsed) {
      applyEventToSnapshot(run.snapshot, parsed);
    }
  }

  if (event.terminal) {
    run.state = event.terminal;
    if (event.terminal === "error") {
      run.error = event.error;
    }
  }
}

/**
 * Snapshot projection: render each run as an `AGUIAgentToolEventMessage` in
 * `orderedRunIds` insertion order. The snapshot's `messages` array is copied
 * so callers can mutate freely without disturbing reducer state.
 */
export function getAGUIAgentToolMessages(
  state: AGUIAgentToolEventState
): AGUIAgentToolEventMessage[] {
  const out: AGUIAgentToolEventMessage[] = [];
  for (const runId of state.orderedRunIds) {
    const run = state.runs.get(runId);
    if (!run) continue;
    out.push({
      runId: run.runId,
      parentToolCallId: run.parentToolCallId,
      messages: [...run.snapshot.messages],
      state: run.state,
      error: run.error,
      lastSequence: run.lastSequence
    });
  }
  return out;
}

// ============================================================================
// Helpers
// ============================================================================

function tryParseAGUIEvent(body: string): AGUIEvent | undefined {
  try {
    return JSON.parse(body) as AGUIEvent;
  } catch (err) {
    console.warn("[agui-agent-tools] malformed event body", err, body);
    return undefined;
  }
}
