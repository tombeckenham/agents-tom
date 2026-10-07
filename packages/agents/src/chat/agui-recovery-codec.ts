/**
 * `AGUIRecoveryCodec` — the AG-UI implementation of the {@link ChatRecoveryCodec}
 * seam. Replays stored AG-UI SSE event bodies through the snapshot reducer
 * (`agui-message-builder`) to reconstruct the interrupted turn's partial state,
 * and owns the AG-UI chunk-vocabulary side of the recovery progress rules.
 * Mirrors `AISDKRecoveryCodec` (recovery-codec.ts) for the AG-UI event set.
 *
 * The engine seam is vocabulary-agnostic: `RecoveryPartial.parts` here carries
 * the reconstructed `AGUIMessage[]` snapshot (opaque to the engine), and
 * `hasSettledToolResults` is true when the partial already contains a settled
 * `ToolMessage` — completed, often non-idempotent work that must never be
 * dropped by a `{ persist: false }` recovery return (#1631).
 *
 * @internal Shared chat-recovery internals; not a public API.
 */

import {
  applyEventToSnapshot,
  createInitialSnapshot
} from "./agui-message-builder";
import type { AGUIEvent, AGUIMessage } from "./agui-types";
import type { ChatRecoveryCodec } from "./recovery-codec";

export class AGUIRecoveryCodec implements ChatRecoveryCodec {
  toRecoveryPartial(bodies: string[]): {
    text: string;
    parts: AGUIMessage[];
    hasSettledToolResults: boolean;
  } {
    const snapshot = createInitialSnapshot();
    for (const body of bodies) {
      try {
        applyEventToSnapshot(snapshot, JSON.parse(body) as AGUIEvent);
      } catch {
        // skip malformed chunks
      }
    }
    const text = snapshot.messages
      .filter((m) => m.role === "assistant" && typeof m.content === "string")
      .map((m) => m.content as string)
      .join("");
    return {
      text,
      parts: snapshot.messages,
      hasSettledToolResults: snapshot.messages.some((m) => m.role === "tool")
    };
  }

  /** Milestones: a started segment or a settled tool input/output (#1637). */
  isProgressChunk(type: string | undefined): boolean {
    return (
      type === "TEXT_MESSAGE_START" ||
      type === "REASONING_MESSAGE_START" ||
      type === "REASONING_START" ||
      type === "TOOL_CALL_END" ||
      type === "TOOL_CALL_RESULT"
    );
  }

  /** Mid-segment deltas, credited through the shared time throttle. */
  isStreamingContentChunk(type: string | undefined): boolean {
    return (
      type === "TEXT_MESSAGE_CONTENT" ||
      type === "REASONING_MESSAGE_CONTENT" ||
      type === "TOOL_CALL_ARGS"
    );
  }
}

/** Shared stateless {@link AGUIRecoveryCodec} instance. */
export const aguiRecoveryCodec = new AGUIRecoveryCodec();
