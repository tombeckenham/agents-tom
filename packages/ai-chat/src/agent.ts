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
 * - `this.messages` projects the AG-UI store via `toUIMessages`; writes
 *   (setter, `saveMessages`, `persistMessages`) accept `UIMessage[]` and run
 *   the `migrateUIMessageToAGUI` pipeline (`autoTransformAGUIMessages`).
 * - Lifecycle hooks (`onChatResponse`, `onChatRecovery`,
 *   `sanitizeMessageForPersistence`) keep their legacy shapes; the engine's
 *   dispatch seams project in and out.
 *
 * Persisted rows are AG-UI (`_v` marker); legacy rows migrate on load. This
 * file is a Phase-3 sidecar: `src/index.ts` (the legacy implementation) is
 * untouched until the Phase-5 differential cutover swaps it for this class.
 *
 * NOTE: the agent-tool child-adapter surface (`startAgentToolRun` etc.) and
 * detached-delivery members are NOT yet ported to the AG-UI engine and are
 * absent here — see the Phase-3 report for the accounting.
 */

import type { GenerateTextOnFinishCallback, ToolSet, UIMessage } from "ai";
import {
  AGUIChatAgent,
  type AGUIChatRecoveryContext,
  type AGUIChatResponseResult,
  type AGUIMessage,
  type OnChatMessageOptions
} from "agents/agui-chat-agent";
import {
  autoTransformAGUIMessages,
  sanitizeAGUIMessage,
  type ChatRecoveryContext,
  type ChatRecoveryOptions,
  type ChatResponseResult,
  type MessagePart,
  type SaveMessagesOptions,
  type SaveMessagesResult
} from "agents/chat";
import { toAGUIResponse, toUIMessages } from "@cloudflare/ai-chat-vercel";

export type ChatMessage = UIMessage;
export type { OnChatMessageOptions };

/**
 * AI SDK chat agent, projected onto the AG-UI engine. Public API matches the
 * legacy `AIChatAgent` in `src/index.ts`.
 */
export class AIChatAgent<
  Env extends Cloudflare.Env = Cloudflare.Env,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>
> extends AGUIChatAgent<Env, State, Props> {
  /**
   * Array of chat messages for the current conversation, projected from the
   * AG-UI store on every read. Assignment migrates back to AG-UI rows.
   *
   * Known divergence from legacy: in-place mutation
   * (`this.messages.push(...)`) mutates a projection and is lost — assign or
   * use `saveMessages`/`persistMessages` instead.
   */
  // The legacy public surface is UIMessage[]; the engine's canonical store
  // stays AGUIMessage[].
  // @ts-expect-error TS2416 — intentional projection override
  override get messages(): ChatMessage[] {
    return toUIMessages(this._aguiMessages);
  }
  // @ts-expect-error TS2416 — intentional projection override
  override set messages(value: ChatMessage[]) {
    this._aguiMessages = autoTransformAGUIMessages(value);
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
    response: Response | undefined
  ): Response | undefined {
    if (!response?.body) return response;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) return response;
    return toAGUIResponse(response);
  }

  protected override _invokeChatResponseHook(
    result: AGUIChatResponseResult
  ): void | Promise<void> {
    const projected = toUIMessages(result.messages);
    const message: ChatMessage = [...projected]
      .reverse()
      .find((m) => m.role === "assistant") ?? {
      // A turn that produced no assistant content (e.g. errored before the
      // first delta): legacy still passed the (empty) streaming message.
      id: result.requestId,
      role: "assistant",
      parts: []
    };
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

  protected override _sanitizeMessageForPersistence(
    message: AGUIMessage
  ): AGUIMessage {
    const base = sanitizeAGUIMessage(message);
    // Fast path: the legacy hook was not overridden — skip the lossy
    // UIMessage round-trip entirely.
    if (
      this.sanitizeMessageForPersistence ===
      AIChatAgent.prototype.sanitizeMessageForPersistence
    ) {
      return base;
    }
    // Round-trip a single row through the legacy hook. A lone assistant/user
    // row projects 1:1; rows with no standalone UIMessage projection (tool
    // results, activity) skip the hook.
    const [projected] = toUIMessages([base]);
    if (!projected) return base;
    const transformed = this.sanitizeMessageForPersistence(projected);
    const [migrated] = autoTransformAGUIMessages([transformed]);
    return migrated ?? base;
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
        async (current) =>
          autoTransformAGUIMessages(await messages(toUIMessages(current))),
        options
      );
    }
    return super.saveMessages(autoTransformAGUIMessages(messages), options);
  }

  // Legacy surface takes UIMessage[]. Engine-internal calls pass AG-UI rows,
  // which the migration pipeline passes through unchanged.
  // @ts-expect-error TS2416 — intentional projection override
  override async persistMessages(
    messages: ChatMessage[],
    excludeBroadcastIds: string[] = [],
    options?: { _deleteStaleRows?: boolean }
  ): Promise<void> {
    return super.persistMessages(
      autoTransformAGUIMessages(messages),
      excludeBroadcastIds,
      options
    );
  }
}
