/**
 * `AIChatAgent` reimplemented as a projection layer over `AGUIChatAgent`.
 *
 * The engine (turns, persistence, recovery, transport) is the AG-UI canonical
 * implementation in `agents/agui-chat-agent`; this class adapts its surface to
 * the legacy AI SDK vocabulary:
 *
 * - `onChatMessage` keeps its AI SDK signature. The returned `UIMessageChunk`
 *   SSE `Response` is piped through the server-side chunk→event projection
 *   (`toAGUIResponse`) before the engine's `_reply` consumes it. Plaintext
 *   responses pass through untouched (the engine synthesizes TEXT events).
 * - `this.messages` projects the AG-UI store via `toUIMessages` (memoized on
 *   store identity, frozen); writes (setter, `saveMessages`,
 *   `persistMessages`) accept `UIMessage[]` and run the migration pipeline.
 * - Lifecycle hooks (`onChatResponse`, `onChatRecovery`,
 *   `sanitizeMessageForPersistence`) keep their legacy shapes; the engine's
 *   dispatch seams project in and out.
 *
 * Persisted rows are AG-UI (`_v` marker); legacy rows migrate on load. This
 * file is a Phase-3 sidecar: `src/index.ts` (the legacy implementation) is
 * untouched until the Phase-5 differential cutover swaps it for this class.
 *
 * NOTE: the agent-tool child-adapter surface (`startAgentToolRun`,
 * `tailAgentToolRun`, `reportProgress`, detached delivery, …) is inherited
 * from the AG-UI engine (Phase 3b) and works for a projected child as-is.
 * Caveat: the overridable hooks `formatAgentToolInput` / `getAgentToolOutput`
 * / `getAgentToolSummary` now speak `AGUIMessage`, not `UIMessage` — a
 * subclass migrating legacy overrides of those hooks needs a projection seam
 * here (Phase 5 conformance work).
 */

import type { GenerateTextOnFinishCallback, ToolSet, UIMessage } from "ai";
import {
  AGUIChatAgent,
  type AGUIChatRecoveryContext,
  type AGUIChatResponseResult,
  type AGUIMessage,
  type OnChatMessageOptions,
  type ProjectHandlerContext,
  type ToolMessage
} from "agents/agui-chat-agent";
import {
  autoTransformAGUIMessages,
  sanitizeAGUIMessage,
  toUIMessages,
  type ChatRecoveryContext,
  type ChatRecoveryOptions,
  type ChatResponseResult,
  type MessagePart,
  type SaveMessagesOptions,
  type SaveMessagesResult
} from "agents/chat";
import { toAGUIResponse } from "@cloudflare/ai-chat-vercel";

export type ChatMessage = UIMessage;
export type { OnChatMessageOptions };

/**
 * Accept either legacy `UIMessage[]` or clean AG-UI rows. Engine-internal
 * persists pass AG-UI rows on the hot path — the migration pipeline's shape
 * guards must never get a chance to drop one of those, so it only runs when
 * a legacy `parts[]` row is actually present.
 */
function toAGUIRows(messages: readonly unknown[]): AGUIMessage[] {
  return messages.some((m) =>
    Array.isArray((m as { parts?: unknown } | null)?.parts)
  )
    ? autoTransformAGUIMessages(messages as unknown[])
    : ([...messages] as AGUIMessage[]);
}

function parseJSON(value: string | undefined): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * AI SDK chat agent, projected onto the AG-UI engine. Public API matches the
 * legacy `AIChatAgent` in `src/index.ts`.
 */
export class AIChatAgent<
  Env extends Cloudflare.Env = Cloudflare.Env,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>
> extends AGUIChatAgent<Env, State, Props> {
  /** Memoized projection keyed on the AG-UI store's array identity. */
  private _uiProjection?: {
    source: readonly AGUIMessage[];
    view: ChatMessage[];
  };

  /**
   * Array of chat messages for the current conversation, projected from the
   * AG-UI store. Assignment migrates back to AG-UI rows. The array is frozen:
   * legacy in-place mutation (`this.messages.push(...)`) cannot be honored by
   * a projection, so it throws instead of being silently lost — assign or use
   * `saveMessages`/`persistMessages`.
   */
  // The legacy public surface is UIMessage[]; the engine's canonical store
  // stays AGUIMessage[].
  // @ts-expect-error TS2416 — intentional projection override
  override get messages(): ChatMessage[] {
    const source = this._aguiMessages;
    if (this._uiProjection?.source !== source) {
      this._uiProjection = {
        source,
        view: Object.freeze(toUIMessages(source)) as unknown as ChatMessage[]
      };
    }
    return this._uiProjection.view;
  }
  // @ts-expect-error TS2416 — intentional projection override
  override set messages(value: ChatMessage[]) {
    this._aguiMessages = toAGUIRows(value);
  }

  /**
   * Override to handle a chat turn. Return a `Response` whose body is an AI
   * SDK `UIMessageChunk` SSE stream (`toUIMessageStreamResponse()`), or a
   * plaintext `Response`.
   */
  override async onChatMessage(
    // oxlint-disable-next-line eslint(no-unused-vars) -- params used by subclass overrides
    _onFinish: GenerateTextOnFinishCallback<ToolSet>,
    // oxlint-disable-next-line eslint(no-unused-vars) -- params used by subclass overrides
    _options?: OnChatMessageOptions
  ): Promise<Response | undefined> {
    throw new Error(
      "received a chat message, override onChatMessage and return a Response to send to the client"
    );
  }

  /** Same contract as the legacy hook; see `src/index.ts`. */
  // @ts-expect-error TS2416 — intentional projection: legacy hook shape
  protected override onChatResponse(
    // oxlint-disable-next-line eslint(no-unused-vars) -- params used by subclass overrides
    _result: ChatResponseResult
  ): void | Promise<void> {}

  /** Same contract as the legacy hook; see `src/index.ts`. */
  // @ts-expect-error TS2416 — intentional projection: legacy hook shape
  protected override sanitizeMessageForPersistence(
    // oxlint-disable-next-line eslint(no-unused-vars) -- params used by subclass overrides
    message: ChatMessage
  ): ChatMessage {
    return message;
  }

  /** Same contract as the legacy hook; see `src/index.ts`. */
  // @ts-expect-error TS2416 — intentional projection: legacy hook shape
  protected override async onChatRecovery(
    // oxlint-disable-next-line @typescript-eslint/no-unused-vars -- overridable hook
    _ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions | void> {
    return {};
  }

  // ──────────────────────────────────────────────────────────────────
  // Engine seam overrides — the projections themselves
  // ──────────────────────────────────────────────────────────────────

  /** UIMessageChunk SSE → AG-UI SSE; plaintext/empty pass through. */
  protected override _projectHandlerResponse(
    response: Response | undefined,
    context?: ProjectHandlerContext
  ): Response | undefined {
    if (!response?.body) return response;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) return response;
    // A continuation anchors streamed text on the seed assistant so it
    // extends that message (legacy cloning behavior) instead of opening a
    // second assistant row.
    return toAGUIResponse(
      response,
      context?.seedAssistantId !== undefined
        ? { messageId: context.seedAssistantId }
        : undefined
    );
  }

  protected override _invokeChatResponseHook(
    result: AGUIChatResponseResult
  ): void | Promise<void> {
    const projected = toUIMessages(result.messages);
    let message = [...projected].reverse().find((m) => m.role === "assistant");
    if (!message) {
      // A turn with no projectable assistant content: keep the streaming
      // assistant's generated id when one exists; requestId is the last
      // resort.
      const lastAssistant = [...result.messages]
        .reverse()
        .find((m) => m.role === "assistant");
      message = {
        id: lastAssistant?.id ?? result.requestId,
        role: "assistant",
        parts: []
      };
    }
    return this.onChatResponse({
      message,
      requestId: result.requestId,
      continuation: result.continuation,
      status: result.status,
      ...(result.error !== undefined && { error: result.error })
    });
  }

  protected override async _invokeChatRecoveryHook(
    ctx: AGUIChatRecoveryContext
  ): Promise<ChatRecoveryOptions | void> {
    return this.onChatRecovery({
      ...ctx,
      messages: toUIMessages(ctx.messages),
      partialParts: toUIMessages(ctx.partialParts).flatMap(
        (m) => m.parts
      ) as MessagePart[]
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // sanitizeMessageForPersistence projection
  // ──────────────────────────────────────────────────────────────────

  protected override _sanitizeMessageForPersistence(
    message: AGUIMessage,
    context?: readonly AGUIMessage[]
  ): AGUIMessage {
    const base = sanitizeAGUIMessage(message);
    // Fast path: the legacy hook was not overridden — byte-exact engine
    // behavior, no projection round-trip.
    if (
      this.sanitizeMessageForPersistence ===
      AIChatAgent.prototype.sanitizeMessageForPersistence
    ) {
      return base;
    }
    switch (base.role) {
      case "activity":
        // No UIMessage representation; the hook cannot see these.
        return base;
      case "tool":
        return this._sanitizeToolRowThroughHook(base, context);
      case "reasoning":
        return this._sanitizeReasoningRowThroughHook(base);
      default:
        return this._sanitizeRowThroughHook(base);
    }
  }

  /** Run the legacy hook, throwing if it returns a non-UIMessage (item: a
   * redaction hook must never silently fail into persisting the original). */
  private _runSanitizeHook(message: ChatMessage): ChatMessage {
    const result = this.sanitizeMessageForPersistence(message);
    const shaped = result as {
      id?: unknown;
      role?: unknown;
      parts?: unknown;
    } | null;
    if (
      !shaped ||
      typeof shaped !== "object" ||
      typeof shaped.id !== "string" ||
      typeof shaped.role !== "string" ||
      !Array.isArray(shaped.parts)
    ) {
      throw new Error(
        "[AIChatAgent] sanitizeMessageForPersistence must return a UIMessage"
      );
    }
    return result;
  }

  /** user/system/developer/assistant rows project 1:1 through the hook. */
  private _sanitizeRowThroughHook(base: AGUIMessage): AGUIMessage {
    const [projected] = toUIMessages([base]);
    if (!projected) return base;
    const transformed = this._runSanitizeHook(projected);
    const migrated = autoTransformAGUIMessages([transformed]);
    const next = migrated.find((m) => m.role === base.role) ?? migrated[0];
    if (!next) {
      throw new Error(
        "[AIChatAgent] sanitizeMessageForPersistence returned a message that cannot be persisted"
      );
    }
    // `name` has no UIMessage slot — carry it from the original.
    return base.name !== undefined
      ? ({ ...next, name: base.name } as AGUIMessage)
      : next;
  }

  /**
   * Tool result rows: synthesize the documented hook shape — the issuing
   * assistant's tool part carrying this output — then map the (possibly
   * redacted) output/error back onto the row. Fields with no part slot
   * (`encryptedValue`) are carried through untouched.
   */
  private _sanitizeToolRowThroughHook(
    base: ToolMessage,
    context: readonly AGUIMessage[] | undefined
  ): AGUIMessage {
    const call = this._findToolCallForSanitize(base.toolCallId, context);
    if (!call) return base;
    const part: Record<string, unknown> = {
      type: `tool-${call.function.name}`,
      toolCallId: base.toolCallId,
      toolName: call.function.name,
      input: parseJSON(call.function.arguments)
    };
    if (base.error) {
      part.state = "output-error";
      part.errorText = base.error;
    } else {
      part.state = "output-available";
      part.output = parseJSON(base.content);
    }
    const transformed = this._runSanitizeHook({
      id: base.id,
      role: "assistant",
      parts: [part]
    } as ChatMessage);
    const after = transformed.parts.find(
      (p) => (p as { toolCallId?: string }).toolCallId === base.toolCallId
    ) as Record<string, unknown> | undefined;
    // Hook removed the part: nothing expressible — keep the original row.
    if (!after) return base;

    if (after.state === "output-error") {
      const errorText =
        typeof after.errorText === "string"
          ? after.errorText
          : (base.error ?? "Tool execution failed.");
      if (errorText === base.error) return base;
      return {
        ...base,
        content: JSON.stringify({ error: errorText }),
        error: errorText
      };
    }
    // Output path. Preserve the original row byte-exactly when unchanged.
    if (
      !base.error &&
      JSON.stringify(after.output) === JSON.stringify(parseJSON(base.content))
    ) {
      return base;
    }
    const content =
      typeof after.output === "string"
        ? after.output
        : JSON.stringify(after.output ?? null);
    const next: ToolMessage = { ...base, content };
    delete (next as { error?: string }).error;
    return next;
  }

  private _findToolCallForSanitize(
    toolCallId: string,
    context: readonly AGUIMessage[] | undefined
  ) {
    for (const list of [context ?? [], this._aguiMessages]) {
      for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        if (m.role !== "assistant") continue;
        const call = m.toolCalls?.find((tc) => tc.id === toolCallId);
        if (call) return call;
      }
    }
    return undefined;
  }

  /**
   * Reasoning rows project through the standalone-reasoning fallback and map
   * the hook's reasoning text back, preserving `encryptedValue` and the
   * stable row id (no full migrate round-trip — that path re-derives ids).
   */
  private _sanitizeReasoningRowThroughHook(base: AGUIMessage): AGUIMessage {
    const [projected] = toUIMessages([base]);
    if (!projected) return base;
    const transformed = this._runSanitizeHook(projected);
    const text = transformed.parts
      .filter(
        (p): p is Extract<typeof p, { type: "reasoning" }> =>
          p.type === "reasoning"
      )
      .map((p) => p.text ?? "")
      .join("");
    const next = { ...base, content: text } as AGUIMessage & {
      metadata?: unknown;
    };
    if (transformed.metadata !== undefined) {
      next.metadata = transformed.metadata;
    } else {
      delete next.metadata;
    }
    return next;
  }

  // ──────────────────────────────────────────────────────────────────
  // Programmatic entry points (legacy UIMessage[] surface)
  // ──────────────────────────────────────────────────────────────────

  // Legacy surface takes UIMessage[]; inputs migrate to AG-UI before the
  // engine persists.
  // @ts-expect-error TS2416 — intentional projection override
  override async saveMessages(
    messages:
      | ChatMessage[]
      | ((
          currentMessages: readonly ChatMessage[]
        ) => ChatMessage[] | Promise<ChatMessage[]>),
    options?: SaveMessagesOptions
  ): Promise<SaveMessagesResult> {
    if (typeof messages === "function") {
      return super.saveMessages(
        async (current) => toAGUIRows(await messages(toUIMessages(current))),
        options
      );
    }
    return super.saveMessages(toAGUIRows(messages), options);
  }

  // Legacy surface takes UIMessage[]. Engine-internal calls pass AG-UI rows
  // on the hot path — `toAGUIRows` passes those through untouched so a
  // shape-guard can never drop one.
  // @ts-expect-error TS2416 — intentional projection override
  override async persistMessages(
    messages: ChatMessage[],
    excludeBroadcastIds: string[] = [],
    options?: { _deleteStaleRows?: boolean }
  ): Promise<void> {
    return super.persistMessages(
      toAGUIRows(messages),
      excludeBroadcastIds,
      options
    );
  }
}
