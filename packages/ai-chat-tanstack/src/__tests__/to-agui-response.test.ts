/**
 * Unit tests for {@link toAGUIResponse} — the server-side SSE encoder.
 *
 * TanStack `chat()` returns `AsyncIterable<AGUIEvent>`; the helper wraps
 * that into a `Response` whose body is one `data: {…}\n\n` SSE frame per
 * event. Identity adapter — no projection step.
 */

import type { AGUIEvent } from "agents/chat/agui-types";
import { describe, expect, it } from "vitest";
import { toAGUIResponse } from "../index";

async function* events(items: AGUIEvent[]): AsyncIterable<AGUIEvent> {
  for (const item of items) yield item;
}

async function* erroringStream(
  items: AGUIEvent[],
  err: Error
): AsyncIterable<AGUIEvent> {
  for (const item of items) yield item;
  throw err;
}

async function readAll(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

function parseSSEDataLines(body: string): unknown[] {
  const frames = body.split("\n\n").filter((f) => f.length > 0);
  return frames.map((frame) => {
    const line = frame.trimEnd();
    expect(line.startsWith("data: ")).toBe(true);
    return JSON.parse(line.slice("data: ".length)) as unknown;
  });
}

describe("toAGUIResponse — framing", () => {
  it("emits one data: {…JSON}\\n\\n frame per event, in iteration order", async () => {
    const items: AGUIEvent[] = [
      { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
      { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Hi" },
      { type: "TEXT_MESSAGE_END", messageId: "m1" },
      { type: "RUN_FINISHED", threadId: "t1", runId: "r1" }
    ];
    const response = toAGUIResponse(events(items));
    const body = await readAll(response);
    const parsed = parseSSEDataLines(body);
    expect(parsed).toEqual(items);
  });

  it("yields zero frames for an empty iterable", async () => {
    const response = toAGUIResponse(events([]));
    const body = await readAll(response);
    expect(body).toBe("");
  });

  it("preserves custom CUSTOM events including tool-approval requests", async () => {
    const items: AGUIEvent[] = [
      {
        type: "CUSTOM",
        name: "cf.agents.tool_approval.request",
        value: { toolCallId: "tc-1", approvalId: "ap-1", toolName: "delete" }
      }
    ];
    const response = toAGUIResponse(events(items));
    const body = await readAll(response);
    const parsed = parseSSEDataLines(body);
    expect(parsed).toEqual(items);
  });
});

describe("toAGUIResponse — finish reason", () => {
  const finished = { type: "RUN_FINISHED", threadId: "t1", runId: "r1" };
  const sent = async (event: object) =>
    parseSSEDataLines(
      await readAll(toAGUIResponse(events([event as AGUIEvent])))
    )[0];

  it("copies TanStack AI's finishReason onto result, in the AI SDK spelling", async () => {
    expect(await sent({ ...finished, finishReason: "stop" })).toMatchObject({
      result: { finishReason: "stop" }
    });
    expect(
      await sent({ ...finished, finishReason: "tool_calls" })
    ).toMatchObject({ result: { finishReason: "tool-calls" } });
  });

  it("reads the reason from metadata.tanstack on a spec-stripped event", async () => {
    expect(
      await sent({
        ...finished,
        result: { usage: 1 },
        metadata: { tanstack: { finishReason: "stop" } }
      })
    ).toMatchObject({ result: { usage: 1, finishReason: "stop" } });
  });

  it("leaves an event alone when it has a result reason or no reason", async () => {
    const own = {
      ...finished,
      finishReason: "stop",
      result: { finishReason: "length" }
    };
    expect(await sent(own)).toEqual(own);
    expect(await sent(finished)).toEqual(finished);
    const opaque = { ...finished, finishReason: "stop", result: "done" };
    expect(await sent(opaque)).toEqual(opaque);
  });
});

describe("toAGUIResponse — headers", () => {
  it("sets Content-Type: text/event-stream; charset=utf-8 and SSE cache headers", async () => {
    const response = toAGUIResponse(events([]));
    expect(response.headers.get("Content-Type")).toBe(
      "text/event-stream; charset=utf-8"
    );
    expect(response.headers.get("Cache-Control")).toBe(
      "no-cache, no-transform"
    );
    expect(response.headers.get("Connection")).toBe("keep-alive");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");
  });

  it("merges with caller-provided init.headers without clobbering core SSE headers", async () => {
    const response = toAGUIResponse(events([]), {
      init: {
        status: 200,
        headers: { "X-Custom": "yes" }
      }
    });
    expect(response.headers.get("X-Custom")).toBe("yes");
    expect(response.headers.get("Content-Type")).toBe(
      "text/event-stream; charset=utf-8"
    );
  });
});

describe("toAGUIResponse — errors", () => {
  it("propagates an iterable error onto the stream (no half-written frames)", async () => {
    const items: AGUIEvent[] = [
      { type: "RUN_STARTED", threadId: "t1", runId: "r1" }
    ];
    const boom = new Error("boom");
    const response = toAGUIResponse(erroringStream(items, boom));
    // Consume — the first frame is fine, the error surfaces on the next pull.
    if (!response.body) throw new Error("missing body");
    const reader = response.body.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    // Subsequent read should reject with the iterable's error.
    await expect(reader.read()).rejects.toThrow("boom");
  });

  it("calls iterator.return() when the stream is cancelled before exhaustion", async () => {
    let returned = false;
    const iter: AsyncIterable<AGUIEvent> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<AGUIEvent>> {
            return {
              value: { type: "RUN_STARTED", threadId: "t1", runId: "r1" },
              done: false
            };
          },
          async return(): Promise<IteratorResult<AGUIEvent>> {
            returned = true;
            return { value: undefined, done: true };
          }
        };
      }
    };
    const response = toAGUIResponse(iter);
    if (!response.body) throw new Error("missing body");
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
    // microtask flush
    await new Promise((r) => setTimeout(r, 0));
    expect(returned).toBe(true);
  });
});
