/**
 * AG-UI message sanitization and row-size enforcement.
 *
 * Sidecar to `sanitize.ts` (Vercel UIMessage shape). Same behavioral contract,
 * different message shape. See `design/rfc-ag-ui-canonical.md` for the
 * canonical surface.
 */

import type {
  AGUIMessage,
  AssistantMessage,
  ReasoningMessage,
  ToolCall,
  ToolMessage
} from "./agui-types";
import { truncateToolOutput } from "./tool-output-truncation";

const textEncoder = new TextEncoder();

export const ROW_MAX_BYTES = 1_800_000;

const PROVIDER_TOOL_MAX_STRING_LENGTH = 500;

const TEXT_TRUNCATE_THRESHOLD = 1000;
const TEXT_TRUNCATE_KEEP = 500;

// Ephemeral provider metadata keys ported from sanitize.ts (Vercel sanitizer).
// These appear in OpenAI Responses payloads and must never be persisted —
// downstream replays reject them.
const OPENAI_EPHEMERAL_KEYS = ["itemId", "reasoningEncryptedContent"] as const;

export function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

/**
 * Per-message sanitization. Strips ephemeral provider keys; returns the input
 * reference unchanged when nothing needed cleaning. Whole-message drops
 * (empty reasoning) are not performed here — callers iterating a list should
 * use `isEmptyReasoningMessage` to filter after sanitizing.
 */
export function sanitizeAGUIMessage(message: AGUIMessage): AGUIMessage {
  if (!isWellFormed(message)) {
    console.warn("sanitizeAGUIMessage: malformed message, passing through", {
      message
    });
    return message;
  }

  switch (message.role) {
    case "reasoning":
      return sanitizeReasoning(message);
    case "tool":
      return sanitizeTool(message);
    case "assistant":
      return sanitizeAssistant(message);
    default:
      return message;
  }
}

/**
 * Predicate matching the Vercel sanitizer's "empty reasoning part" filter
 * lifted to the AG-UI shape: a reasoning message with no content and no
 * encrypted blob carries no information and should be dropped before persist.
 */
export function isEmptyReasoningMessage(message: AGUIMessage): boolean {
  if (message.role !== "reasoning") return false;
  const content = (message.content ?? "").trim();
  const encrypted =
    typeof message.encryptedValue === "string" &&
    message.encryptedValue.length > 0;
  return content === "" && !encrypted;
}

export function enforceRowSizeLimit(message: AGUIMessage): AGUIMessage {
  if (!isWellFormed(message)) {
    console.warn("enforceRowSizeLimit: malformed message, passing through", {
      message
    });
    return message;
  }

  const initialSize = byteLength(JSON.stringify(message));
  if (initialSize <= ROW_MAX_BYTES) return message;

  if (message.role === "tool") {
    return truncateToolMessage(message);
  }

  if (message.role === "assistant") {
    const compacted = compactAssistantToolArgs(message);
    if (byteLength(JSON.stringify(compacted)) <= ROW_MAX_BYTES)
      return compacted;
    return truncateAssistantContent(compacted);
  }

  return truncateGenericContent(message);
}

export function truncateToolMessageContent(
  content: string,
  max: number = PROVIDER_TOOL_MAX_STRING_LENGTH
): string {
  if (content.length <= max) return content;
  const result = truncateToolOutput(content, max);
  if (typeof result.output === "string") return result.output;
  return JSON.stringify(result.output);
}

// ---------- internals ----------

function isWellFormed(message: AGUIMessage): boolean {
  if (!message || typeof message !== "object") return false;
  const role = (message as { role?: unknown }).role;
  if (typeof role !== "string") return false;
  return true;
}

function sanitizeReasoning(message: ReasoningMessage): ReasoningMessage {
  return stripEphemeralKeys(message);
}

function sanitizeTool(message: ToolMessage): ToolMessage {
  return stripEphemeralKeys(message);
}

function sanitizeAssistant(message: AssistantMessage): AssistantMessage {
  const stripped = stripEphemeralKeys(message);
  if (!stripped.toolCalls || stripped.toolCalls.length === 0) return stripped;

  let mutated = stripped !== message;
  const cleanedCalls: ToolCall[] = stripped.toolCalls.map((call) => {
    const cleaned = stripEphemeralKeys(call);
    if (cleaned !== call) mutated = true;
    return cleaned;
  });

  if (!mutated) return message;
  return { ...stripped, toolCalls: cleanedCalls };
}

function stripEphemeralKeys<T extends object>(value: T): T {
  let mutated = false;
  const result: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(value)) {
    if ((OPENAI_EPHEMERAL_KEYS as readonly string[]).includes(key)) {
      mutated = true;
      continue;
    }
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const recursed = stripEphemeralKeys(val as Record<string, unknown>);
      if (recursed !== val) mutated = true;
      result[key] = recursed;
    } else {
      result[key] = val;
    }
  }

  if (!mutated) return value;
  return result as T;
}

function truncateToolMessage(message: ToolMessage): ToolMessage {
  const truncated = truncateToolMessageContent(message.content);
  if (truncated === message.content) return message;
  return { ...message, content: truncated };
}

function compactAssistantToolArgs(message: AssistantMessage): AssistantMessage {
  if (!message.toolCalls || message.toolCalls.length === 0) return message;

  let mutated = false;
  const compactedCalls: ToolCall[] = message.toolCalls.map((call) => {
    const args = call.function.arguments;
    if (args.length <= PROVIDER_TOOL_MAX_STRING_LENGTH) return call;
    mutated = true;
    const truncated = truncateToolMessageContent(args);
    return {
      ...call,
      function: { ...call.function, arguments: truncated }
    };
  });

  if (!mutated) return message;
  return { ...message, toolCalls: compactedCalls };
}

function truncateAssistantContent(message: AssistantMessage): AssistantMessage {
  const content = message.content;
  if (
    typeof content !== "string" ||
    content.length <= TEXT_TRUNCATE_THRESHOLD
  ) {
    return message;
  }
  return { ...message, content: truncationMarker(content) };
}

function truncateGenericContent(message: AGUIMessage): AGUIMessage {
  if (message.role === "user") {
    const content = message.content;
    if (
      typeof content !== "string" ||
      content.length <= TEXT_TRUNCATE_THRESHOLD
    ) {
      return message;
    }
    return { ...message, content: truncationMarker(content) };
  }

  if (message.role === "system" || message.role === "developer") {
    if (message.content.length <= TEXT_TRUNCATE_THRESHOLD) return message;
    return { ...message, content: truncationMarker(message.content) };
  }

  if (message.role === "reasoning") {
    const content = message.content ?? "";
    if (content.length <= TEXT_TRUNCATE_THRESHOLD) return message;
    return { ...message, content: truncationMarker(content) };
  }

  return message;
}

function truncationMarker(text: string): string {
  return (
    `[Text truncated for storage (${text.length} chars). ` +
    `First ${TEXT_TRUNCATE_KEEP} chars: ${text.slice(0, TEXT_TRUNCATE_KEEP)}...]`
  );
}
