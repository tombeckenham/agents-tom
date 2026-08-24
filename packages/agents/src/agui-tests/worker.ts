/**
 * Test worker for the `AGUIChatAgent` server suite.
 *
 * Each fixture agent returns a deterministic AG-UI SSE `Response` from
 * `onChatMessage` so tests can assert on the exact wire frames, persistence
 * rows, and lifecycle side-effects. Fixtures expose a `/probe` route via
 * `onRequest` where a test needs to observe captured server state.
 */

import { routeAgentRequest } from "../index";
import {
  AGUIChatAgent,
  type AGUIMessage,
  type OnChatMessageOptions
} from "../agui-chat-agent";
import { CF_TOOL_APPROVAL_REQUEST, type AGUIEvent } from "../chat/agui-types";

function sseResponse(
  events: AGUIEvent[],
  options?: { delayMs?: number; signal?: AbortSignal; holdMsAfter?: number }
): Response {
  const encoder = new TextEncoder();
  const delayMs = options?.delayMs ?? 0;
  const signal = options?.signal;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const event of events) {
        if (signal?.aborted) break;
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
        );
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
      if (options?.holdMsAfter && !signal?.aborted) {
        await new Promise((resolve) =>
          setTimeout(resolve, options.holdMsAfter)
        );
      }
      controller.close();
    }
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" }
  });
}

function textRunEvents(messageId: string, deltas: string[]): AGUIEvent[] {
  return [
    { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
    { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
    ...deltas.map(
      (delta): AGUIEvent => ({
        type: "TEXT_MESSAGE_CONTENT",
        messageId,
        delta
      })
    ),
    { type: "TEXT_MESSAGE_END", messageId },
    { type: "RUN_FINISHED", threadId: "t1", runId: "r1" }
  ];
}

/** Streams a fixed two-delta assistant reply. */
export class EchoAguiAgent extends AGUIChatAgent<Env> {
  // eslint-disable-next-line @typescript-eslint/require-await
  async onChatMessage() {
    return sseResponse(
      textRunEvents(`assistant-${Date.now()}`, ["Hello ", "world"])
    );
  }
}

/** Streams a tool call plus its result, then a closing text run. */
export class ToolCallAguiAgent extends AGUIChatAgent<Env> {
  // eslint-disable-next-line @typescript-eslint/require-await
  async onChatMessage() {
    const messageId = `assistant-${Date.now()}`;
    const events: AGUIEvent[] = [
      { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
      { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
      {
        type: "TOOL_CALL_START",
        toolCallId: "tc-1",
        toolCallName: "getWeather",
        parentMessageId: messageId
      },
      { type: "TOOL_CALL_ARGS", toolCallId: "tc-1", delta: '{"city":' },
      { type: "TOOL_CALL_ARGS", toolCallId: "tc-1", delta: '"Sydney"}' },
      { type: "TOOL_CALL_END", toolCallId: "tc-1" },
      {
        type: "TOOL_CALL_RESULT",
        messageId: "tool-1",
        toolCallId: "tc-1",
        content: JSON.stringify({ temp: 21 })
      },
      { type: "TEXT_MESSAGE_CONTENT", messageId, delta: "It is 21C" },
      { type: "TEXT_MESSAGE_END", messageId },
      { type: "RUN_FINISHED", threadId: "t1", runId: "r1" }
    ];
    return sseResponse(events);
  }
}

/**
 * Streams slowly (100ms per event) so tests can cancel mid-stream or attach
 * a second client while the stream is active. Records whether the
 * `abortSignal` fired; exposed via the `/probe` route.
 */
export class SlowAguiAgent extends AGUIChatAgent<Env> {
  private _sawAbort = false;

  // eslint-disable-next-line @typescript-eslint/require-await
  async onChatMessage(
    _onFinish: (result: unknown) => void | Promise<void>,
    options?: OnChatMessageOptions
  ) {
    options?.abortSignal?.addEventListener("abort", () => {
      this._sawAbort = true;
    });
    const messageId = `assistant-${Date.now()}`;
    return sseResponse(textRunEvents(messageId, Array(12).fill("tick ")), {
      delayMs: 100,
      signal: options?.abortSignal
    });
  }

  async onRequest(request: Request): Promise<Response> {
    if (new URL(request.url).pathname.endsWith("/probe")) {
      return Response.json({ sawAbort: this._sawAbort });
    }
    return super.onRequest(request);
  }
}

/** Returns a plaintext (non-SSE) Response — must be wrapped in a synthetic run. */
export class PlaintextAguiAgent extends AGUIChatAgent<Env> {
  // eslint-disable-next-line @typescript-eslint/require-await
  async onChatMessage() {
    return new Response("plain answer", {
      headers: { "Content-Type": "text/plain" }
    });
  }
}

/** Throws before producing a Response — the pre-stream error path. */
export class PreThrowAguiAgent extends AGUIChatAgent<Env> {
  // eslint-disable-next-line @typescript-eslint/require-await
  async onChatMessage(): Promise<Response | undefined> {
    throw new Error("boom before response");
  }
}

/** SSE body that errors mid-stream after one event. */
export class ErrorStreamAguiAgent extends AGUIChatAgent<Env> {
  // eslint-disable-next-line @typescript-eslint/require-await
  async onChatMessage() {
    const encoder = new TextEncoder();
    let pulled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!pulled) {
          pulled = true;
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "RUN_STARTED", threadId: "t1", runId: "r1" })}\n\n`
            )
          );
          return;
        }
        throw new Error("boom mid-stream");
      }
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream" }
    });
  }
}

/**
 * Streams a tool call whose approval is requested mid-stream, then holds the
 * stream open so tests can observe the eager persistence and send the
 * approval decision while the turn is still live.
 */
export class ApprovalAguiAgent extends AGUIChatAgent<Env> {
  // eslint-disable-next-line @typescript-eslint/require-await
  async onChatMessage() {
    const messageId = "assistant-approval";
    const events: AGUIEvent[] = [
      { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
      { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
      {
        type: "TOOL_CALL_START",
        toolCallId: "tc-approve",
        toolCallName: "deleteEverything",
        parentMessageId: messageId
      },
      { type: "TOOL_CALL_ARGS", toolCallId: "tc-approve", delta: "{}" },
      { type: "TOOL_CALL_END", toolCallId: "tc-approve" },
      {
        type: "CUSTOM",
        name: CF_TOOL_APPROVAL_REQUEST,
        value: {
          toolCallId: "tc-approve",
          approvalId: "ap-1",
          toolName: "deleteEverything"
        }
      },
      { type: "TEXT_MESSAGE_END", messageId },
      { type: "RUN_FINISHED", threadId: "t1", runId: "r1" }
    ];
    return sseResponse(events, { holdMsAfter: 2000 });
  }
}

/** Keeps at most 2 persisted rows. */
export class MaxPersistedAguiAgent extends AGUIChatAgent<Env> {
  maxPersistedMessages = 2;

  // eslint-disable-next-line @typescript-eslint/require-await
  async onChatMessage() {
    return sseResponse(textRunEvents(`assistant-${Date.now()}`, ["ok"]));
  }
}

/** Exposes `saveMessages` through a `/trigger-save` route. */
export class SaveMessagesAguiAgent extends AGUIChatAgent<Env> {
  // eslint-disable-next-line @typescript-eslint/require-await
  async onChatMessage() {
    return sseResponse(textRunEvents("assistant-saved", ["saved-reply"]));
  }

  async onRequest(request: Request): Promise<Response> {
    if (new URL(request.url).pathname.endsWith("/trigger-save")) {
      const messages = (await request.json()) as AGUIMessage[];
      const result = await this.saveMessages(messages);
      return Response.json(result);
    }
    return super.onRequest(request);
  }
}

export type Env = {
  EchoAguiAgent: DurableObjectNamespace<EchoAguiAgent>;
  ToolCallAguiAgent: DurableObjectNamespace<ToolCallAguiAgent>;
  SlowAguiAgent: DurableObjectNamespace<SlowAguiAgent>;
  PlaintextAguiAgent: DurableObjectNamespace<PlaintextAguiAgent>;
  PreThrowAguiAgent: DurableObjectNamespace<PreThrowAguiAgent>;
  ErrorStreamAguiAgent: DurableObjectNamespace<ErrorStreamAguiAgent>;
  ApprovalAguiAgent: DurableObjectNamespace<ApprovalAguiAgent>;
  MaxPersistedAguiAgent: DurableObjectNamespace<MaxPersistedAguiAgent>;
  SaveMessagesAguiAgent: DurableObjectNamespace<SaveMessagesAguiAgent>;
};

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
