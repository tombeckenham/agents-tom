/**
 * `useAgentChat` follows the socket when the agent address changes (#1864,
 * #1874, upstream #2394).
 *
 * `useAgent` addresses a new agent at least one render before its socket
 * does: it keeps returning the previous socket object, renamed to the new
 * leaf, with `getHttpUrl()` returning "" and the registered
 * `cloudflare.agents.socketAddressPending` symbol set. The upstream suite
 * drives this through a real `useAgent` and a test worker
 * (`agents/src/react-tests/initial-messages-address-change.test.tsx`); this
 * package's hook tests have no worker, so the fake agent below reproduces
 * those three renders by hand.
 */
import { Suspense, act, useEffect, useState } from "react";
import type { UIMessage } from "ai";
import { cleanup, render } from "vitest-browser-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { useAgent } from "agents/react";
import { useAgentChat } from "../react";

const SOCKET_ADDRESS_PENDING = Symbol.for(
  "cloudflare.agents.socketAddressPending"
);

type LoaderOptions = { agent: string; name: string; url?: string };

function createSocket(name: string, token: string) {
  const target = new EventTarget();
  const url = `http://localhost:3000/agents/chat/${name}?token=${token}`;
  let pending = false;
  const socket = {
    _pk: name,
    addEventListener: target.addEventListener.bind(target),
    agent: "chat",
    close: () => {},
    // While its address is pending, `useAgent` hides the previous socket's
    // URL: it names the previous agent and carries its credentials.
    getHttpUrl: () => (pending ? "" : url),
    id: `socket-${name}`,
    name,
    path: [{ agent: "chat", name }],
    removeEventListener: target.removeEventListener.bind(target),
    send: () => {}
  };
  return {
    agent: socket as unknown as ReturnType<typeof useAgent>,
    /** What `useAgent` does to the socket it still holds on a name change. */
    readdress(nextName: string) {
      pending = true;
      socket.name = nextName;
      socket.path = [{ agent: "chat", name: nextName }];
      (socket as { [SOCKET_ADDRESS_PENDING]?: boolean })[
        SOCKET_ADDRESS_PENDING
      ] = true;
    }
  };
}

function historyFor(name: string): UIMessage[] {
  return [
    {
      id: `${name}-message`,
      role: "user",
      parts: [{ type: "text", text: `hello ${name}` }]
    }
  ];
}

describe("useAgentChat when the agent address changes", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("loads the new agent's history through the new socket URL (#1864, #1874)", async () => {
    const getInitialMessages = vi.fn(async (options: LoaderOptions) =>
      historyFor(options.name)
    );
    const first = createSocket("address-change-a", "token-a");
    const second = createSocket("address-change-b", "token-b");
    const renders: string[][] = [];
    let setAgent: ((agent: ReturnType<typeof useAgent>) => void) | undefined;
    let rerender: (() => void) | undefined;

    function TestComponent() {
      const [agent, setAgentState] = useState(first.agent);
      const [, setTick] = useState(0);
      useEffect(() => {
        setAgent = setAgentState;
        rerender = () => setTick((tick) => tick + 1);
      }, []);
      const { messages } = useAgentChat({
        agent,
        getInitialMessages,
        resume: false
      });
      renders.push(messages.map((message) => message.id));
      return <div data-testid="ready">ready</div>;
    }

    await render(
      <Suspense fallback="loading">
        <TestComponent />
      </Suspense>
    );
    await vi.waitFor(() =>
      expect(renders.at(-1)).toEqual(["address-change-a-message"])
    );
    expect(getInitialMessages.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        name: "address-change-a",
        url: expect.stringContaining("/address-change-a?token=token-a")
      })
    );

    getInitialMessages.mockClear();
    // The render where the options name agent B but the socket is still A's.
    await act(async () => {
      first.readdress("address-change-b");
      rerender?.();
    });
    // The effect has replaced the socket.
    await act(async () => {
      setAgent?.(second.agent);
    });

    await vi.waitFor(() => expect(getInitialMessages).toHaveBeenCalled());
    // Every load names one agent and fetches that same agent, with its own
    // token.
    for (const [options] of getInitialMessages.mock.calls) {
      expect(options).toEqual(
        expect.objectContaining({
          name: "address-change-b",
          url: expect.stringContaining("/address-change-b?token=token-b")
        })
      );
    }
    await vi.waitFor(() =>
      expect(renders.at(-1)).toEqual(["address-change-b-message"])
    );
  });
});
