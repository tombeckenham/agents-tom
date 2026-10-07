/**
 * The transcript lives in Sessions as AG-UI rows. A Durable Object can reach
 * this build from three starting states, and none may lose its transcript:
 *
 *  (a) legacy AI SDK rows in `cf_ai_chat_agent_messages`
 *  (b) the AG-UI engine's own `_v` rows in that table
 *  (c) upstream `AIChatAgent` storage: `UIMessage` rows in the default session
 */

import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "../index";
import {
  PERSISTED_MESSAGE_SCHEMA_VERSION,
  type AGUIMessage
} from "../chat/agui-types";

async function freshAgent() {
  return getAgentByName(env.EchoAguiAgent, `storage-${crypto.randomUUID()}`);
}

interface StorageState {
  messages: AGUIMessage[];
  stored: AGUIMessage[];
  legacyTables: string[];
  upstreamRows: number;
  continuationRows: number;
  attachments: number;
}

// The RPC stub types an `AGUIMessage` payload as `never` (open metadata bags
// are not provably serializable), so the state is read through a typed view.
function storageState(stub: object): Promise<StorageState> {
  return (
    stub as { storageStateForTest(): Promise<StorageState> }
  ).storageStateForTest();
}

const ids = (messages: AGUIMessage[]) => messages.map((m) => m.id);

describe("AGUIChatAgent — transcript on Sessions", () => {
  it("(a) lifts legacy AI SDK rows out of the table and drops it", async () => {
    const stub = await freshAgent();
    await stub.seedLegacyTableForTest([
      {
        id: "u1",
        message: JSON.stringify({
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "weather?" }]
        })
      },
      {
        id: "a1",
        message: JSON.stringify({
          id: "a1",
          role: "assistant",
          parts: [
            {
              type: "tool-getWeather",
              toolCallId: "call-1",
              state: "output-available",
              input: { city: "Paris" },
              output: { temp: 21 }
            },
            { type: "text", text: "It is 21 degrees.", state: "done" }
          ]
        })
      }
    ]);
    await evictDurableObject(stub);

    const lifted = await storageState(stub);
    expect(lifted.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool"
    ]);
    expect(lifted.messages[0]).toMatchObject({ id: "u1", content: "weather?" });
    expect(lifted.messages[1]).toMatchObject({
      id: "a1",
      content: "It is 21 degrees."
    });
    expect(lifted.messages[2]).toMatchObject({
      toolCallId: "call-1",
      content: JSON.stringify({ temp: 21 })
    });
    expect(lifted.stored).toEqual(lifted.messages);
    expect(lifted.legacyTables).toEqual([]);

    // A second wake reads the same transcript from Sessions alone.
    await evictDurableObject(stub);
    const again = await storageState(stub);
    expect(again.messages).toEqual(lifted.messages);
    expect(again.legacyTables).toEqual([]);
  });

  it("(b) lifts the engine's own AG-UI rows without changing them", async () => {
    const stub = await freshAgent();
    const rows: AGUIMessage[] = [
      { id: "u1", role: "user", content: "run it" },
      { id: "r1", role: "reasoning", content: "thinking" },
      {
        id: "a1",
        role: "assistant",
        content: "done",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "run", arguments: "{}" }
          }
        ]
      },
      { id: "t1", role: "tool", toolCallId: "call-1", content: '"ok"' }
    ];
    await stub.seedLegacyTableForTest(
      rows.map((row) => ({
        id: row.id,
        message: JSON.stringify({
          ...row,
          _v: PERSISTED_MESSAGE_SCHEMA_VERSION
        })
      }))
    );
    await evictDurableObject(stub);

    const lifted = await storageState(stub);
    expect(lifted.messages).toEqual(rows);
    expect(lifted.stored).toEqual(rows);
    expect(lifted.legacyTables).toEqual([]);

    // New writes land after the lifted rows, and survive a wake in order.
    await stub.persistForTest([
      ...rows,
      { id: "u2", role: "user", content: "again" }
    ]);
    await evictDurableObject(stub);
    expect(ids((await storageState(stub)).messages)).toEqual([
      "u1",
      "r1",
      "a1",
      "t1",
      "u2"
    ]);
  });

  it("(c) lifts a transcript upstream AIChatAgent stored in the default session", async () => {
    const stub = await freshAgent();
    const longText = "p".repeat(2 * 1024 * 1024);
    const image = btoa("i".repeat(64 * 1024));
    await stub.seedUpstreamSessionForTest([
      {
        id: "u1",
        role: "user",
        parts: [
          { type: "text", text: "look" },
          {
            type: "file",
            mediaType: "image/png",
            url: `data:image/png;base64,${image}`
          }
        ]
      },
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-getWeather",
            toolCallId: "call-1",
            state: "output-available",
            input: {},
            output: "sunny"
          },
          { type: "text", text: longText }
        ]
      },
      { id: "u2", role: "user", parts: [{ type: "text", text: "thanks" }] }
    ]);
    await evictDurableObject(stub);

    const lifted = await storageState(stub);
    expect(lifted.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "user"
    ]);
    expect(lifted.messages[0]).toMatchObject({
      id: "u1",
      content: [
        { type: "text", text: "look" },
        {
          type: "image",
          source: { type: "data", value: image, mimeType: "image/png" }
        }
      ]
    });
    expect(lifted.messages[1]).toMatchObject({ id: "a1", content: longText });
    expect(lifted.messages[2]).toMatchObject({
      toolCallId: "call-1",
      content: '"sunny"'
    });
    expect(lifted.messages[3]).toMatchObject({ id: "u2", content: "thanks" });
    expect(lifted.stored).toEqual(lifted.messages);
    // The source session is emptied once every row has a copy.
    expect(lifted.upstreamRows).toBe(0);
    // The image is an attachment; only the long text spans continuation rows.
    expect(lifted.attachments).toBe(1);
    expect(lifted.continuationRows).toBeGreaterThan(0);

    await evictDurableObject(stub);
    expect((await storageState(stub)).messages).toEqual(lifted.messages);
  });

  it("keeps the table when a row cannot be migrated, and lifts only once", async () => {
    const stub = await freshAgent();
    await stub.seedLegacyTableForTest([
      {
        id: "u1",
        message: JSON.stringify({ id: "u1", role: "user", content: "hi" })
      },
      { id: "bad", message: "{not json" }
    ]);
    await evictDurableObject(stub);

    const lifted = await storageState(stub);
    expect(ids(lifted.messages)).toEqual(["u1"]);
    expect(lifted.legacyTables).toEqual(["cf_ai_chat_agent_messages"]);

    // The source is still there, but a later wake must not re-append a
    // message the user has since removed.
    await stub.clearTranscriptForTest();
    await evictDurableObject(stub);
    const after = await storageState(stub);
    expect(after.messages).toEqual([]);
    expect(after.legacyTables).toEqual(["cf_ai_chat_agent_messages"]);
  });

  it("stores inline media as an attachment and reads it back unchanged", async () => {
    const stub = await freshAgent();
    const message: AGUIMessage = {
      id: "u1",
      role: "user",
      content: [
        { type: "text", text: "look" },
        {
          type: "image",
          source: {
            type: "data",
            value: btoa("o".repeat(2 * 1024 * 1024)),
            mimeType: "image/png"
          }
        }
      ]
    };
    await stub.persistForTest([message]);

    const state = await storageState(stub);
    expect(state.attachments).toBe(1);
    expect(state.continuationRows).toBe(0);
    expect(state.stored).toEqual([message]);

    await evictDurableObject(stub);
    expect((await storageState(stub)).messages).toEqual([message]);
  });
});
