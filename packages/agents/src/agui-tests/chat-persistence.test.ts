/**
 * Happy-path chat turn + persistence.
 *
 * A CF_AGENT_USE_CHAT_REQUEST must stream USE_CHAT_RESPONSE frames whose
 * bodies are raw AG-UI event JSON, terminate with done:true, and persist
 * both the user turn and the accumulated assistant turn as AGUIMessage rows
 * carrying the `_v` schema marker. The `/get-messages` endpoint returns the
 * persisted rows.
 */

import { describe, expect, it } from "vitest";
import { PERSISTED_MESSAGE_SCHEMA_VERSION } from "../chat/agui-types";
import {
  connectChatWS,
  eventsForRequest,
  isDoneFrame,
  recordFrames,
  sendChatRequest,
  userMessage,
  waitForPersisted
} from "./test-utils";

describe("AGUIChatAgent — chat turn and persistence", () => {
  it("streams AG-UI events and finishes with done:true", async () => {
    const path = `/agents/echo-agui-agent/${crypto.randomUUID()}`;
    const ws = await connectChatWS(path);
    const rec = recordFrames(ws);

    sendChatRequest(ws, "req1", [userMessage("u1", "Hello")]);
    await rec.waitFor(isDoneFrame("req1"));

    const events = eventsForRequest(rec.frames, "req1");
    expect(events.map((e) => e.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED"
    ]);
    ws.close(1000);
  });

  it("persists user and assistant messages with the _v schema marker", async () => {
    const path = `/agents/echo-agui-agent/${crypto.randomUUID()}`;
    const ws = await connectChatWS(path);
    const rec = recordFrames(ws);

    sendChatRequest(ws, "req1", [userMessage("u1", "Hello")]);
    await rec.waitFor(isDoneFrame("req1"));
    ws.close(1000);

    const persisted = await waitForPersisted(path, (ms) =>
      ms.some((m) => m.role === "assistant")
    );
    const user = persisted.find((m) => m.role === "user");
    const assistant = persisted.find((m) => m.role === "assistant");
    expect(user).toBeDefined();
    expect(user?.id).toBe("u1");
    expect(user?._v).toBe(PERSISTED_MESSAGE_SCHEMA_VERSION);
    expect(assistant).toBeDefined();
    expect(assistant?._v).toBe(PERSISTED_MESSAGE_SCHEMA_VERSION);
    expect((assistant as { content?: string }).content).toBe("Hello world");
  });

  it("accumulates history across two turns", async () => {
    const path = `/agents/echo-agui-agent/${crypto.randomUUID()}`;
    const ws = await connectChatWS(path);
    const rec = recordFrames(ws);

    sendChatRequest(ws, "req1", [userMessage("u1", "first")]);
    await rec.waitFor(isDoneFrame("req1"));

    const mid = await waitForPersisted(path, (ms) =>
      ms.some((m) => m.role === "assistant")
    );
    const firstAssistant = mid.find((m) => m.role === "assistant");
    expect(firstAssistant).toBeDefined();

    sendChatRequest(ws, "req2", [
      userMessage("u1", "first"),
      firstAssistant as never,
      userMessage("u2", "second")
    ]);
    await rec.waitFor(isDoneFrame("req2"));
    ws.close(1000);

    const persisted = await waitForPersisted(
      path,
      (ms) => ms.filter((m) => m.role === "assistant").length >= 2
    );
    expect(persisted.filter((m) => m.role === "user").length).toBe(2);
    expect(
      persisted.filter((m) => m.role === "assistant").length
    ).toBeGreaterThanOrEqual(2);
  });
});
