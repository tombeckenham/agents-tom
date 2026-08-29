/**
 * AG-UI persistence migration shim.
 *
 * Pattern mirrors `packages/ai-chat/src/ai-chat-v5-migration.ts`:
 * a one-shot, lazy-on-load transform. `cf_ai_chat_agent_messages`
 * rows written by the new AG-UI lifecycle carry a top-level `_v`
 * marker (`PERSISTED_MESSAGE_SCHEMA_VERSION`); legacy rows written
 * by the previous Vercel `UIMessage`-shaped persistence layer do
 * not. On load we detect each row and either parse-as-AG-UI or
 * migrate-from-UIMessage in memory so the rest of the agent only
 * ever sees `AGUIMessage`.
 *
 * Schema-marker placement: we use a top-level non-discriminator
 * field `_v` on the persisted JSON (cheap to detect, no envelope
 * wrapping required, ignored by AG-UI consumers because their
 * unions discriminate on `role`). On load we strip `_v` before
 * returning so the in-memory shape stays a clean `AGUIMessage`.
 *
 * Reference: `design/discovery-agui-types.md` §
 * "UIMessage → AG-UI (write-time / migration direction)" and the
 * loss summary, and `design/discovery-uimessage-coupling.md`
 * § "Migration on load".
 */

import {
  type AGUIInputContent,
  type AGUIInputContentSource,
  type AGUIMessage,
  type AGUIRole,
  type AssistantExtraPart,
  type AssistantMessage,
  type DeveloperMessage,
  PERSISTED_MESSAGE_SCHEMA_VERSION,
  type ReasoningMessage,
  type SystemMessage,
  type ToolApprovalState,
  type ToolCall,
  type ToolMessage,
  type UserMessage
} from "./agui-types";

const AGUI_ROLES = new Set<AGUIRole>([
  "user",
  "assistant",
  "system",
  "tool",
  "developer",
  "reasoning",
  "activity"
]);

// ----------------------------------------------------------------------------
// Persisted envelope shape (top-level `_v` marker)
// ----------------------------------------------------------------------------

/**
 * Persisted AG-UI row: an `AGUIMessage` with the schema-version
 * marker attached as a top-level `_v` field. The marker is stripped
 * on load.
 */
type PersistedAGUIMessage = AGUIMessage & {
  readonly _v: typeof PERSISTED_MESSAGE_SCHEMA_VERSION;
};

// ----------------------------------------------------------------------------
// Structural type guards
// ----------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True when `value` is a persisted AG-UI message envelope:
 * an object with `_v === PERSISTED_MESSAGE_SCHEMA_VERSION` plus
 * the minimum AG-UI fields (`id`, `role`). Role-specific shape
 * validation happens at the union level; we only need enough here
 * to distinguish from a legacy UIMessage row.
 */
export function isPersistedAGUIMessage(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value._v !== PERSISTED_MESSAGE_SCHEMA_VERSION) return false;
  if (typeof value.id !== "string") return false;
  if (typeof value.role !== "string") return false;
  return true;
}

/**
 * True when `value` matches the legacy v5 `UIMessage` shape:
 * `{ id: string, role: string, parts: unknown[] }`. Matches the
 * existing `isUIMessage` guard in `ai-chat-v5-migration.ts`.
 */
export function isLegacyUIMessage(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (typeof value.id !== "string") return false;
  if (typeof value.role !== "string") return false;
  if (!Array.isArray(value.parts)) return false;
  return true;
}

/**
 * True when `value` is already a clean `AGUIMessage`: an `id`-bearing object
 * with an AG-UI `role` and no legacy `parts[]` array. Used for wire-incoming
 * payloads from native AG-UI clients, which never carry the persistence `_v`
 * marker. Excludes legacy UIMessage rows (those carry `parts`) so they still
 * flow through `migrateUIMessageToAGUI`.
 */
export function isCleanAGUIMessage(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (typeof value.id !== "string") return false;
  if (typeof value.role !== "string") return false;
  if (!AGUI_ROLES.has(value.role as AGUIRole)) return false;
  if (Array.isArray(value.parts)) return false;
  return true;
}

// ----------------------------------------------------------------------------
// Top-level loader
// ----------------------------------------------------------------------------

/**
 * Per-row transform run on every message that flows into the agent — both
 * persisted rows loaded from `cf_ai_chat_agent_messages` and wire-incoming
 * payloads from clients. Persisted rows carry the `_v` marker and pass
 * through (marker stripped); legacy v5 `UIMessage` rows get one-shot
 * migrated; clean AG-UI rows (from native AG-UI clients) pass through
 * unchanged. Unrecognized rows are skipped with a warning — no fallback
 * fabrication.
 */
export function autoTransformAGUIMessages(
  rawMessages: unknown[]
): AGUIMessage[] {
  const out: AGUIMessage[] = [];
  for (const raw of rawMessages) {
    if (isPersistedAGUIMessage(raw)) {
      out.push(stripVersionMarker(raw as PersistedAGUIMessage));
      continue;
    }
    if (isLegacyUIMessage(raw)) {
      for (const migrated of migrateUIMessageToAGUI(raw)) {
        out.push(migrated);
      }
      continue;
    }
    if (isCleanAGUIMessage(raw)) {
      out.push(raw as AGUIMessage);
      continue;
    }
    console.warn(
      "[agents/chat/agui-migration] Skipping unrecognized message row",
      raw
    );
  }
  return out;
}

function stripVersionMarker(persisted: PersistedAGUIMessage): AGUIMessage {
  const { _v, ...rest } = persisted;
  void _v;
  return rest as AGUIMessage;
}

// ----------------------------------------------------------------------------
// UIMessage → AG-UI translation
// ----------------------------------------------------------------------------

/**
 * Narrow shape we read off a legacy `UIMessage`. We only touch
 * the fields used by the translation; everything else is ignored.
 */
type LegacyMessage = {
  id: string;
  role: string;
  parts: unknown[];
  metadata?: unknown;
};

type LegacyTextPart = {
  type: "text";
  text?: string;
  state?: string;
};

type LegacyReasoningPart = {
  type: "reasoning";
  text?: string;
  state?: string;
};

type LegacyFilePart = {
  type: "file";
  mediaType?: string;
  url?: string;
  filename?: string;
};

type LegacyToolPart = {
  type: string; // `tool-${name}`
  toolCallId?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  approval?: { id?: string; approved?: boolean };
};

type LegacyDataPart = {
  type: string; // `data-${name}`
  id?: string;
  data?: unknown;
};

/**
 * Translate one legacy `UIMessage` into one or more `AGUIMessage`s.
 * The result is an array because the AG-UI `Message` union splits
 * what `UIMessage` collapses: a single assistant `UIMessage` with
 * `text + tool + reasoning` parts becomes one `ReasoningMessage`
 * (before), one `AssistantMessage`, and one `ToolMessage` per tool
 * part in `output-available`. See discovery doc § "UIMessage →
 * AG-UI" for the full mapping table.
 */
export function migrateUIMessageToAGUI(uiMessage: unknown): AGUIMessage[] {
  if (!isLegacyUIMessage(uiMessage)) {
    console.warn(
      "[agents/chat/agui-migration] migrateUIMessageToAGUI received non-UIMessage value",
      uiMessage
    );
    return [];
  }
  const msg = uiMessage as LegacyMessage;
  switch (msg.role) {
    case "user":
      return migrateUserMessage(msg);
    case "system":
      return migrateSystemMessage(msg);
    case "assistant":
      return migrateAssistantMessage(msg);
    default:
      // Unknown role: AG-UI's Message union does not accept it.
      // No fabrication — skip with a warning.
      console.warn(
        "[agents/chat/agui-migration] Skipping legacy message with unknown role",
        msg.role
      );
      return [];
  }
}

// ---------------- user ----------------

function migrateUserMessage(msg: LegacyMessage): AGUIMessage[] {
  const textParts = msg.parts.filter(isTextPart);
  const filePartsOnly = msg.parts.every((p) => isTextPart(p) || isFilePart(p));
  // WHY: discovery doc — single-text user messages collapse to
  // `content: string`, multimodal user messages become
  // `content: InputContent[]`.
  if (
    msg.parts.length === textParts.length &&
    textParts.length === 1 &&
    filePartsOnly
  ) {
    const user: UserMessage = {
      id: msg.id,
      role: "user",
      content: textParts[0].text ?? "",
      ...(msg.metadata !== undefined && { metadata: msg.metadata })
    };
    return [user];
  }
  const content: AGUIInputContent[] = [];
  for (const part of msg.parts) {
    if (isTextPart(part)) {
      content.push({ type: "text", text: part.text ?? "" });
      continue;
    }
    if (isFilePart(part)) {
      const ic = filePartToInputContent(part);
      if (ic) content.push(ic);
      continue;
    }
    // WHY: discovery doc loss summary — `source-url`,
    // `source-document`, `data-*` user parts have no AG-UI
    // content slot. Drop with a warning rather than fabricate.
    console.warn(
      "[agents/chat/agui-migration] Dropping unsupported user message part",
      (part as { type?: string })?.type
    );
  }
  const user: UserMessage = {
    id: msg.id,
    role: "user",
    content,
    ...(msg.metadata !== undefined && { metadata: msg.metadata })
  };
  return [user];
}

function filePartToInputContent(
  part: LegacyFilePart
): AGUIInputContent | undefined {
  if (!part.url) {
    console.warn("[agents/chat/agui-migration] Dropping file part without url");
    return undefined;
  }
  const mediaType = part.mediaType ?? "application/octet-stream";
  const kind = classifyMedia(mediaType);
  const source: AGUIInputContentSource = part.url.startsWith("data:")
    ? parseDataUrl(part.url, mediaType)
    : { type: "url", value: part.url, mimeType: mediaType };
  return { type: kind, source };
}

function classifyMedia(
  mediaType: string
): "image" | "audio" | "video" | "document" {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  return "document";
}

function parseDataUrl(
  url: string,
  fallbackMime: string
): AGUIInputContentSource {
  // data:<mediaType>[;base64],<value>
  const comma = url.indexOf(",");
  if (comma === -1) {
    return { type: "data", value: "", mimeType: fallbackMime };
  }
  const meta = url.slice(5, comma);
  const value = url.slice(comma + 1);
  const semi = meta.indexOf(";");
  const mimeType = (semi === -1 ? meta : meta.slice(0, semi)) || fallbackMime;
  return { type: "data", value, mimeType };
}

// ---------------- system / developer ----------------

function migrateSystemMessage(msg: LegacyMessage): AGUIMessage[] {
  const text = collectText(msg.parts);
  const aguiRole = readAguiRole(msg.metadata);
  // The aguiRole key is a routing marker, not user data — strip it from the
  // carried metadata so the round-trip is stable.
  const metadata = stripAguiRole(msg.metadata);
  // WHY: discovery doc — UIMessage has no `developer` role; the
  // round-trip carrier is `metadata.aguiRole === "developer"`.
  if (aguiRole === "developer") {
    const dev: DeveloperMessage = {
      id: msg.id,
      role: "developer",
      content: text,
      ...(metadata !== undefined && { metadata })
    };
    return [dev];
  }
  const sys: SystemMessage = {
    id: msg.id,
    role: "system",
    content: text,
    ...(metadata !== undefined && { metadata })
  };
  return [sys];
}

function stripAguiRole(metadata: unknown): unknown {
  if (!isObject(metadata)) return metadata ?? undefined;
  if (!("aguiRole" in metadata)) return metadata;
  const { aguiRole: _aguiRole, ...rest } = metadata;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function readAguiRole(metadata: unknown): string | undefined {
  if (!isObject(metadata)) return undefined;
  const v = metadata.aguiRole;
  return typeof v === "string" ? v : undefined;
}

// ---------------- assistant ----------------

function migrateAssistantMessage(msg: LegacyMessage): AGUIMessage[] {
  const out: AGUIMessage[] = [];

  const reasoningParts = msg.parts.filter(isReasoningPart);
  const reasoningOnly =
    reasoningParts.length > 0 && reasoningParts.length === msg.parts.length;

  // WHY: discovery doc — reasoning messages precede the assistant they
  // relate to in the AG-UI list. A reasoning-only UIMessage (produced by
  // the projection's standalone-reasoning fallback) keeps its id verbatim
  // so migrate→project→migrate is a fixed point — no `-reasoning-N`
  // re-suffixing, no fabricated empty assistant row.
  if (reasoningOnly && reasoningParts.length === 1) {
    const r: ReasoningMessage = {
      id: msg.id,
      role: "reasoning",
      content: reasoningParts[0].text ?? "",
      ...(reasoningParts[0].state === "streaming" && { partial: true as const })
    };
    return [r];
  }
  let reasoningIndex = 0;
  for (const part of reasoningParts) {
    const r: ReasoningMessage = {
      id: `${msg.id}-reasoning-${reasoningIndex++}`,
      role: "reasoning",
      content: part.text ?? "",
      ...(part.state === "streaming" && { partial: true as const })
    };
    out.push(r);
  }
  if (reasoningOnly) return out;

  const textContent = collectText(msg.parts);
  const toolParts = msg.parts.filter(isToolPart);

  const toolCalls: ToolCall[] = [];
  const toolMessages: ToolMessage[] = [];
  const toolApprovals: Record<string, ToolApprovalState> = {};
  let toolResultIndex = 0;
  for (const toolPart of toolParts) {
    const toolName = toolNameFromType(toolPart.type);
    if (!toolName) continue;
    const toolCallId = toolPart.toolCallId;
    if (typeof toolCallId !== "string") {
      console.warn(
        "[agents/chat/agui-migration] Dropping tool part without toolCallId",
        toolPart.type
      );
      continue;
    }
    toolCalls.push({
      id: toolCallId,
      type: "function",
      function: {
        name: toolName,
        arguments: JSON.stringify(toolPart.input ?? {})
      }
    });
    // Approval state rides the CF `toolApprovals` extension so
    // approval-requested / approval-responded / output-denied survive the
    // row shape and project back.
    if (typeof toolPart.approval?.id === "string") {
      toolApprovals[toolCallId] = {
        approvalId: toolPart.approval.id,
        ...(typeof toolPart.approval.approved === "boolean" && {
          approved: toolPart.approval.approved
        })
      };
    }
    // WHY: discovery doc — settled results emit a `ToolMessage`
    // (`output-available`, and `output-error` via the `error` field).
    // Undecided / denied approvals carry no result row — `toolApprovals`
    // is their durable record.
    if (toolPart.state === "output-available") {
      toolMessages.push({
        id: `${msg.id}-tool-${toolResultIndex++}`,
        role: "tool",
        toolCallId,
        content: JSON.stringify(toolPart.output ?? null)
      });
    } else if (toolPart.state === "output-error") {
      const errorText = toolPart.errorText ?? "Tool execution failed.";
      toolMessages.push({
        id: `${msg.id}-tool-${toolResultIndex++}`,
        role: "tool",
        toolCallId,
        content: JSON.stringify({ error: errorText }),
        error: errorText
      });
    }
  }

  const activityMessages: AGUIMessage[] = [];
  const extraParts: AssistantExtraPart[] = [];
  for (const part of msg.parts) {
    if (isDataPart(part)) {
      // WHY: discovery doc — `data-cf.activity` parts round-trip as
      // `ActivityMessage`. Other `data-*` parts ride the `extraParts`
      // CF extension verbatim (as do file/source parts below).
      if (part.type === "data-cf.activity") {
        activityMessages.push({
          id: part.id ?? `${msg.id}-activity-${activityMessages.length}`,
          role: "activity",
          content: part.data
        });
      } else {
        extraParts.push(part as AssistantExtraPart);
      }
      continue;
    }
    if (isExtraAssistantPart(part)) {
      extraParts.push(part as AssistantExtraPart);
    }
  }

  const streamingText = msg.parts.some(
    (part) => isTextPart(part) && part.state === "streaming"
  );
  const assistant: AssistantMessage = {
    id: msg.id,
    role: "assistant",
    ...(textContent ? { content: textContent } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(Object.keys(toolApprovals).length ? { toolApprovals } : {}),
    ...(extraParts.length ? { extraParts } : {}),
    ...(streamingText && { partial: true as const }),
    ...(msg.metadata !== undefined && { metadata: msg.metadata })
  };
  out.push(assistant);
  for (const tm of toolMessages) out.push(tm);
  for (const am of activityMessages) out.push(am);
  return out;
}

/** Assistant parts with no AG-UI slot that ride `extraParts` verbatim. */
function isExtraAssistantPart(value: unknown): boolean {
  if (!isObject(value) || typeof value.type !== "string") return false;
  return (
    value.type === "file" ||
    value.type.startsWith("source-") ||
    value.type === "step-start"
  );
}

// ----------------------------------------------------------------------------
// Part-shape helpers
// ----------------------------------------------------------------------------

function isTextPart(value: unknown): value is LegacyTextPart {
  return isObject(value) && value.type === "text";
}

function isReasoningPart(value: unknown): value is LegacyReasoningPart {
  return isObject(value) && value.type === "reasoning";
}

function isFilePart(value: unknown): value is LegacyFilePart {
  return isObject(value) && value.type === "file";
}

function isToolPart(value: unknown): value is LegacyToolPart {
  return (
    isObject(value) &&
    typeof value.type === "string" &&
    value.type.startsWith("tool-")
  );
}

function isDataPart(value: unknown): value is LegacyDataPart {
  return (
    isObject(value) &&
    typeof value.type === "string" &&
    value.type.startsWith("data-")
  );
}

function toolNameFromType(type: string): string | undefined {
  if (!type.startsWith("tool-")) return undefined;
  const name = type.slice("tool-".length);
  return name.length > 0 ? name : undefined;
}

function collectText(parts: unknown[]): string {
  let buf = "";
  for (const p of parts) {
    if (isTextPart(p) && typeof p.text === "string") buf += p.text;
  }
  return buf;
}
