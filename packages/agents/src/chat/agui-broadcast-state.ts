/**
 * AG-UI broadcast stream state machine.
 *
 * Sidecar to `broadcast-state.ts`: same lifecycle role but typed against
 * the AG-UI event vocabulary and the AGUIStreamAccumulator. Used by
 * AIChatAgent to decide what to broadcast to connected clients as
 * AG-UI events stream in from `_reply`, when a new client joins
 * mid-stream, when the stream ends, or when the chat is cleared.
 *
 * Pure: same (state, event) pair always yields the same result. No
 * side effects, no I/O, no clock. Side effects (sending frames,
 * persisting the message) stay with the caller.
 */

import {
  AGUIStreamAccumulator,
  type AGUIChunkAction
} from "./agui-stream-accumulator";
import type { AGUIEvent, AGUIMessage } from "./agui-types";

// ============================================================================
// State
// ============================================================================

export type AGUIBroadcastStreamState =
  | { status: "idle"; accumulator: null }
  | { status: "streaming"; accumulator: AGUIStreamAccumulator };

// ============================================================================
// Events
// ============================================================================

export type AGUIBroadcastStreamEvent =
  | { type: "response"; event: AGUIEvent }
  | { type: "end" }
  | { type: "snapshot-request"; currentMessages: AGUIMessage[] }
  | { type: "reset" };

// ============================================================================
// Result
// ============================================================================

export interface AGUIBroadcastTransitionResult {
  nextState: AGUIBroadcastStreamState;
  broadcast: AGUIMessage[] | null;
}

// ============================================================================
// Transition
// ============================================================================

const IDLE: AGUIBroadcastStreamState = { status: "idle", accumulator: null };

export function aguiBroadcastTransition(
  state: AGUIBroadcastStreamState,
  event: AGUIBroadcastStreamEvent
): AGUIBroadcastTransitionResult {
  if (!isValidEvent(event)) {
    console.warn("[agui-broadcast-state] malformed event", event);
    return { nextState: state, broadcast: null };
  }

  switch (event.type) {
    case "reset":
      return { nextState: IDLE, broadcast: null };

    case "end":
      // Persistence and any post-stream broadcast are caller-owned; the
      // state machine only releases the accumulator.
      return { nextState: IDLE, broadcast: null };

    case "snapshot-request": {
      if (state.status === "idle") {
        return { nextState: state, broadcast: null };
      }
      return {
        nextState: state,
        broadcast: state.accumulator.mergeInto(event.currentMessages)
      };
    }

    case "response": {
      const accumulator =
        state.status === "streaming"
          ? state.accumulator
          : new AGUIStreamAccumulator();
      const action = accumulator.applyEvent(event.event);
      const nextState: AGUIBroadcastStreamState = {
        status: "streaming",
        accumulator
      };
      if (shouldSuppressBroadcast(action)) {
        return { nextState, broadcast: null };
      }
      return { nextState, broadcast: accumulator.mergeInto([]) };
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function shouldSuppressBroadcast(action: AGUIChunkAction): boolean {
  // `noop` covers RAW, STATE_*, ACTIVITY_*, non-cf CUSTOM, and reasoning
  // block markers — the message snapshot is unchanged so re-broadcasting
  // would only churn clients. `unknown` is reducer-level rejection; the
  // snapshot is similarly unchanged.
  return action.kind === "noop" || action.kind === "unknown";
}

function isValidEvent(event: unknown): event is AGUIBroadcastStreamEvent {
  if (!event || typeof event !== "object") return false;
  const e = event as { type?: unknown };
  if (typeof e.type !== "string") return false;
  switch (e.type) {
    case "reset":
    case "end":
      return true;
    case "response": {
      const inner = (event as { event?: unknown }).event;
      return (
        !!inner &&
        typeof inner === "object" &&
        typeof (inner as { type?: unknown }).type === "string"
      );
    }
    case "snapshot-request": {
      const current = (event as { currentMessages?: unknown }).currentMessages;
      return Array.isArray(current);
    }
    default:
      return false;
  }
}
