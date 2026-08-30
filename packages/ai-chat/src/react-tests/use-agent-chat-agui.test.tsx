/**
 * AG-UI-wire-specific coverage for the Phase-4 hook.
 *
 * The shared `use-agent-chat.test.tsx` suite runs against both hooks through
 * the wire codec in `agui-hook-shim.tsx`, so it can only dispatch frames that
 * exist on BOTH wires. These are the frames whose payload shape is AG-UI's
 * alone, dispatched exactly as `AGUIChatAgent` broadcasts them.
 */

import { StrictMode, Suspense, act } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { UIMessage } from "ai";
import { useAgentChat } from "../react-agui";
import type { useAgent } from "agents/react";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createAgentWithTarget(name: string) {
  const target = new EventTarget();
  const sentMessages: string[] = [];
  const url = `ws://localhost:3000/agents/chat/${name}?_pk=abc`;
  const agent = {
    _pkurl: url,
    _pk: name,
    addEventListener: target.addEventListener.bind(target),
    agent: "Chat",
    close: () => {},
    id: "fake-agent",
    name,
    removeEventListener: target.removeEventListener.bind(target),
    send: (data: string) => sentMessages.push(data),
    dispatchEvent: target.dispatchEvent.bind(target),
    path: [{ agent: "Chat", name }],
    getHttpUrl: () => url.replace("ws://", "http://")
  } as unknown as ReturnType<typeof useAgent>;
  return { agent, target, sentMessages };
}

function dispatch(target: EventTarget, data: Record<string, unknown>) {
  target.dispatchEvent(
    new MessageEvent("message", { data: JSON.stringify(data) })
  );
}

/** An assistant turn with one tool call still awaiting its result. */
function pendingToolMessages(): UIMessage[] {
  return [
    {
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: "tool-getLocation",
          toolCallId: "tool-call-1",
          state: "input-available",
          input: { city: "London" }
        }
      ]
    } as UIMessage
  ];
}

describe("useAgentChat CF_AGENT_MESSAGE_UPDATED (AG-UI tool row)", () => {
  it("folds a broadcast tool result onto the pending tool part", async () => {
    const { agent, target } = createAgentWithTarget("message-updated-result");
    const initialMessages = pendingToolMessages();

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: async () => initialMessages,
        resume: false
      });
      return (
        <div data-testid="parts">
          {JSON.stringify(chat.messages.flatMap((m) => m.parts))}
        </div>
      );
    };

    const screen = await act(async () => {
      const screen = render(<TestComponent />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback="Loading...">{children}</Suspense>
          </StrictMode>
        )
      });
      await sleep(20);
      return screen;
    });

    // Exactly what AGUIChatAgent broadcasts: a standalone AG-UI tool row.
    // `toUIMessages` drops it on its own (it needs the issuing assistant),
    // so the hook has to fold it in by toolCallId.
    await act(async () => {
      dispatch(target, {
        type: "cf_agent_message_updated",
        message: {
          id: "tool_tool-call-1",
          role: "tool",
          toolCallId: "tool-call-1",
          content: JSON.stringify({ lat: 51.5, lng: -0.1 })
        }
      });
      await sleep(20);
    });

    const parts = screen.getByTestId("parts");
    await expect.element(parts).toHaveTextContent('"state":"output-available"');
    await expect.element(parts).toHaveTextContent('"lat":51.5');
  });

  it("folds an errored tool row onto the pending tool part", async () => {
    const { agent, target } = createAgentWithTarget("message-updated-error");
    const initialMessages = pendingToolMessages();

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: async () => initialMessages,
        resume: false
      });
      return (
        <div data-testid="parts">
          {JSON.stringify(chat.messages.flatMap((m) => m.parts))}
        </div>
      );
    };

    const screen = await act(async () => {
      const screen = render(<TestComponent />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback="Loading...">{children}</Suspense>
          </StrictMode>
        )
      });
      await sleep(20);
      return screen;
    });

    // The output-error path has no `clientToolResults` mirror, so a silent
    // no-op here would never surface at all.
    await act(async () => {
      dispatch(target, {
        type: "cf_agent_message_updated",
        message: {
          id: "tool_tool-call-1",
          role: "tool",
          toolCallId: "tool-call-1",
          content: '{"error":"denied"}',
          error: "denied"
        }
      });
      await sleep(20);
    });

    const parts = screen.getByTestId("parts");
    await expect.element(parts).toHaveTextContent('"state":"output-error"');
    await expect.element(parts).toHaveTextContent('"errorText":"denied"');
  });

  it("ignores a tool row for a call this client has never seen (#1094)", async () => {
    const { agent, target } = createAgentWithTarget("message-updated-unknown");
    const initialMessages = pendingToolMessages();

    const TestComponent = () => {
      const chat = useAgentChat({
        agent,
        getInitialMessages: async () => initialMessages,
        resume: false
      });
      return <div data-testid="count">{chat.messages.length}</div>;
    };

    const screen = await act(async () => {
      const screen = render(<TestComponent />, {
        wrapper: ({ children }) => (
          <StrictMode>
            <Suspense fallback="Loading...">{children}</Suspense>
          </StrictMode>
        )
      });
      await sleep(20);
      return screen;
    });

    await act(async () => {
      dispatch(target, {
        type: "cf_agent_message_updated",
        message: {
          id: "tool_other",
          role: "tool",
          toolCallId: "not-in-this-transcript",
          content: "{}"
        }
      });
      await sleep(20);
    });

    await expect.element(screen.getByTestId("count")).toHaveTextContent("1");
  });
});

describe("useAgentChat initial-message hydration (AG-UI /get-messages)", () => {
  it("projects AG-UI rows from the default /get-messages fetch into UIMessages", async () => {
    // Byte-for-byte what `AGUIChatAgent` serves on /get-messages: persisted
    // AG-UI rows, verbatim, including the `_v` schema marker — a user row,
    // a reasoning row, an assistant row with a tool call, and its tool
    // result row. (Pinned against the server by the workers-pool
    // get-messages tests; this leg pins the CLIENT side of the contract.)
    const serverRows = [
      { _v: "v6_agui_message", id: "u-1", role: "user", content: "hi" },
      {
        _v: "v6_agui_message",
        id: "r-1",
        role: "reasoning",
        content: "thinking"
      },
      {
        _v: "v6_agui_message",
        id: "a-1",
        role: "assistant",
        content: "It is 21C",
        toolCalls: [
          {
            id: "tc-1",
            type: "function",
            function: { name: "getWeather", arguments: '{"city":"Sydney"}' }
          }
        ]
      },
      {
        _v: "v6_agui_message",
        id: "tool-1",
        role: "tool",
        toolCallId: "tc-1",
        content: '{"temp":21}'
      }
    ];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(serverRows), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    try {
      const { agent } = createAgentWithTarget("thread-agui-hydration");

      let chatInstance: ReturnType<typeof useAgentChat> | null = null;
      const TestComponent = () => {
        const chat = useAgentChat({ agent });
        chatInstance = chat;
        return (
          <div data-testid="messages">{JSON.stringify(chat.messages)}</div>
        );
      };

      const screen = await act(async () =>
        render(<TestComponent />, {
          wrapper: ({ children }) => (
            <StrictMode>
              <Suspense fallback="Loading...">{children}</Suspense>
            </StrictMode>
          )
        })
      );
      await expect
        .element(screen.getByTestId("messages"))
        .toHaveTextContent("It is 21C");

      const messages = chatInstance!.messages as UIMessage[];
      expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(messages[0].parts).toEqual([{ type: "text", text: "hi" }]);
      // Reasoning folds onto the assistant; the tool row folds onto its part.
      expect(messages[1].parts).toEqual([
        { type: "reasoning", text: "thinking", state: "done" },
        {
          type: "tool-getWeather",
          toolCallId: "tc-1",
          toolName: "getWeather",
          input: { city: "Sydney" },
          state: "output-available",
          output: { temp: 21 }
        },
        { type: "text", text: "It is 21C", state: "done" }
      ]);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
