/**
 * AG-UI message reconciliation — pure functions for aligning client
 * messages with server state during persistence, operating on the
 * canonical `AGUIMessage` shape (sidecar to `message-reconciler.ts`,
 * which speaks Vercel `UIMessage`).
 *
 * Three strategies, applied in order:
 *   1. Merge server-known `ToolMessage` outputs over incoming
 *      `ToolMessage`s for the same `toolCallId` (server is authoritative
 *      once a result lands; clients may carry stale content).
 *   2. Reconcile `AssistantMessage` ids via: exact match → content-key
 *      hash → shared `toolCallId`. The server's id wins because the
 *      server is the only entity that has agreed with persistence.
 *   3. Preserve ordering and assistant/tool pairing: a `ToolMessage`
 *      that follows its owning assistant in `incoming` stays adjacent
 *      to it after reconciliation. No reordering is performed.
 */

import type {
  AGUIMessage,
  AssistantMessage,
  ReasoningMessage,
  ToolCall,
  ToolMessage
} from "./agui-types";

/**
 * Reconcile incoming client messages against server state.
 *
 * @param incoming - Messages from the client.
 * @param server - Current server-side messages (source of truth).
 * @param sanitizeForContentKey - Optional sanitizer applied to messages
 *   before computing their content key (typically strips ephemeral
 *   provider metadata so logically-equivalent assistant turns hash the
 *   same).
 * @returns Reconciled messages, ready for persistence. Order matches
 *   `incoming`; inputs are not mutated.
 */
export function reconcileMessages(
  incoming: AGUIMessage[],
  server: readonly AGUIMessage[],
  sanitizeForContentKey?: (message: AGUIMessage) => AGUIMessage
): AGUIMessage[] {
  const withMergedToolResults = mergeServerToolResults(incoming, server);
  return reconcileAssistantIds(
    withMergedToolResults,
    server,
    sanitizeForContentKey
  );
}

/**
 * For a single message, find the server message id whose `ToolCall`s
 * (when the input is an `AssistantMessage`) or `toolCallId` (when the
 * input is a `ToolMessage`) share an id with this message. Returns
 * `null` when no candidate matches.
 *
 * Tool call ids are unique per conversation, so cross-role matching is
 * safe — an assistant message's `toolCalls[i].id` and a tool message's
 * `toolCallId` reference the same logical call.
 */
export function resolveToolMergeId(
  message: AGUIMessage,
  server: readonly AGUIMessage[]
): string | null {
  const ids = collectToolCallIds(message);
  if (ids.length === 0) return null;

  for (const candidate of server) {
    if (candidate.id === message.id) continue;
    const candidateIds = collectToolCallIds(candidate);
    for (const id of ids) {
      if (candidateIds.includes(id)) return candidate.id;
    }
  }
  return null;
}

/**
 * Stable content-key hash for assistant messages, used for dedup when
 * the assistant id has drifted (e.g. the client generated a temporary
 * id before the server response came back).
 *
 * The key is intentionally narrow:
 *   - `content` — the assistant's text body (final and authoritative).
 *   - `toolCalls` — projected to `{id, name, arguments}` and sorted by
 *     id so streaming order doesn't perturb the hash; this captures
 *     "same tool calls with same arguments", which is the strongest
 *     dedup signal we have when text content is absent.
 *   - `reasoningContent` — when the immediately-preceding message in
 *     the same list is a `ReasoningMessage` paired with this assistant
 *     (same `id` prefix is intentionally not assumed; pairing is
 *     positional in AG-UI), its content is folded in so logically
 *     identical reasoning + assistant pairs collide.
 *
 * Excluded on purpose:
 *   - `id` (we are looking for assistants whose ids drifted).
 *   - `role` (always `"assistant"` at this call site).
 *   - `name` (cosmetic; not stable across producers).
 *   - `encryptedValue` / provider metadata (ephemeral per turn; the
 *     `sanitize` callback is the configured hook for stripping these).
 *
 * Returns `undefined` for non-assistant messages — content-key dedup
 * only makes sense for the role whose ids the server may revise.
 */
export function assistantContentKey(
  message: AGUIMessage,
  sanitize?: (message: AGUIMessage) => AGUIMessage,
  pairedReasoning?: ReasoningMessage
): string | undefined {
  if (message.role !== "assistant") return undefined;
  const sanitized = sanitize ? sanitize(message) : message;
  if (sanitized.role !== "assistant") return undefined;

  const projected = {
    content: sanitized.content ?? "",
    toolCalls: projectToolCallsForKey(sanitized.toolCalls),
    reasoningContent: pairedReasoning?.content ?? ""
  };
  return JSON.stringify(projected);
}

// ─── internals ──────────────────────────────────────────────────────

function mergeServerToolResults(
  incoming: AGUIMessage[],
  server: readonly AGUIMessage[]
): AGUIMessage[] {
  const serverToolMessages = new Map<string, ToolMessage>();
  for (const msg of server) {
    if (!isWellFormed(msg)) continue;
    if (msg.role === "tool") {
      serverToolMessages.set(msg.toolCallId, msg);
    }
  }

  if (serverToolMessages.size === 0) return incoming;

  return incoming.map((msg) => {
    if (!isWellFormed(msg)) return msg;
    if (msg.role !== "tool") return msg;
    const serverTool = serverToolMessages.get(msg.toolCallId);
    if (!serverTool) return msg;
    if (serverTool.id === msg.id && serverTool.content === msg.content) {
      return msg;
    }
    return { ...serverTool };
  });
}

function reconcileAssistantIds(
  incoming: AGUIMessage[],
  server: readonly AGUIMessage[],
  sanitize?: (message: AGUIMessage) => AGUIMessage
): AGUIMessage[] {
  if (server.length === 0) {
    warnMalformed(incoming);
    return incoming.slice();
  }

  const claimedServerIndices = new Set<number>();

  for (let i = 0; i < incoming.length; i++) {
    const incomingMsg = incoming[i];
    if (!isWellFormed(incomingMsg)) continue;
    const serverIdx = server.findIndex(
      (sm, si) =>
        !claimedServerIndices.has(si) &&
        isWellFormed(sm) &&
        sm.id === incomingMsg.id
    );
    if (serverIdx !== -1) claimedServerIndices.add(serverIdx);
  }

  return incoming.map((incomingMessage, i) => {
    if (!isWellFormed(incomingMessage)) {
      console.warn(
        "[agui-message-reconciler] passing through malformed message",
        incomingMessage
      );
      return incomingMessage;
    }

    const exactServerIdx = server.findIndex(
      (sm) => isWellFormed(sm) && sm.id === incomingMessage.id
    );
    if (exactServerIdx !== -1) {
      if (incomingMessage.role === "assistant") {
        const serverMsg = server[exactServerIdx];
        if (serverMsg.role === "assistant") {
          return { ...serverMsg };
        }
      }
      return incomingMessage;
    }

    if (incomingMessage.role !== "assistant") return incomingMessage;

    const pairedReasoning = findPairedReasoning(incoming, i);
    const incomingKey = assistantContentKey(
      incomingMessage,
      sanitize,
      pairedReasoning
    );
    if (incomingKey !== undefined) {
      for (let s = 0; s < server.length; s++) {
        if (claimedServerIndices.has(s)) continue;
        const serverMsg = server[s];
        if (!isWellFormed(serverMsg)) continue;
        if (serverMsg.role !== "assistant") continue;
        const serverPairedReasoning = findPairedReasoning(server, s);
        const serverKey = assistantContentKey(
          serverMsg,
          sanitize,
          serverPairedReasoning
        );
        if (serverKey === incomingKey) {
          claimedServerIndices.add(s);
          return { ...incomingMessage, id: serverMsg.id };
        }
      }
    }

    const toolMergeId = resolveToolMergeId(incomingMessage, server);
    if (toolMergeId !== null && toolMergeId !== incomingMessage.id) {
      return { ...incomingMessage, id: toolMergeId };
    }

    return incomingMessage;
  });
}

function projectToolCallsForKey(
  toolCalls: ToolCall[] | undefined
): Array<{ id: string; name: string; arguments: string }> {
  if (!toolCalls || toolCalls.length === 0) return [];
  return toolCalls
    .map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function collectToolCallIds(message: AGUIMessage): string[] {
  if (!isWellFormed(message)) return [];
  if (message.role === "assistant") {
    return collectAssistantToolCallIds(message);
  }
  if (message.role === "tool") return [message.toolCallId];
  return [];
}

function collectAssistantToolCallIds(message: AssistantMessage): string[] {
  if (!message.toolCalls) return [];
  return message.toolCalls.map((tc) => tc.id);
}

function findPairedReasoning(
  messages: readonly AGUIMessage[],
  assistantIdx: number
): ReasoningMessage | undefined {
  const prev = messages[assistantIdx - 1];
  if (prev && isWellFormed(prev) && prev.role === "reasoning") return prev;
  return undefined;
}

function isWellFormed(
  message: AGUIMessage | undefined | null
): message is AGUIMessage {
  if (!message || typeof message !== "object") return false;
  const msg = message as { id?: unknown; role?: unknown };
  return typeof msg.id === "string" && typeof msg.role === "string";
}

function warnMalformed(messages: readonly AGUIMessage[]): void {
  for (const msg of messages) {
    if (!isWellFormed(msg)) {
      console.warn(
        "[agui-message-reconciler] passing through malformed message",
        msg
      );
    }
  }
}
