// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { TerminalHandle } from "@/components/Terminal";
import type { TerminalDataHandlers, TerminalTransportApi } from "@/lib/direct-transport/contract";

const captured = vi.hoisted(() => ({ instances: [] as unknown[] }));

vi.mock("@xterm/xterm", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@xterm/xterm")>();
  class CapturedTerminal extends mod.Terminal {
    constructor(...args: ConstructorParameters<typeof mod.Terminal>) {
      super(...args);
      captured.instances.push(this);
    }
  }
  return { ...mod, Terminal: CapturedTerminal };
});

beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false, media: q, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {} unobserve() {} disconnect() {}
    };
  }
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  captured.instances.length = 0;
});

function makeTransport() {
  const sent: string[] = [];
  const handlers: { current: TerminalDataHandlers | null } = { current: null };
  const transport = {
    subscribeTerminal: vi.fn((_s: string, _b: string, h: TerminalDataHandlers) => {
      handlers.current = h;
      return () => { handlers.current = null; };
    }),
    sendInput: vi.fn((_s: string, data: string) => { sent.push(data); }),
    sendResize: vi.fn(),
    getMode: vi.fn(() => "centrifugo"),
    onModeChange: vi.fn(() => () => {}),
    getDirectlyReachableBridgeIds: vi.fn(() => []),
    onBridgeReachabilityChange: vi.fn(() => () => {}),
    getFallbackReason: vi.fn(() => null),
    dispose: vi.fn(),
  } as unknown as TerminalTransportApi;
  return { transport, sent, handlers };
}

async function setup() {
  const { Terminal } = await import("@/components/Terminal");
  const { transport, sent, handlers } = makeTransport();
  const ref = createRef<TerminalHandle>();
  const utils = render(
    <Terminal ref={ref} transport={transport} sessionId="s1" bridgeId="b1" isRunning shellType="claude" />,
  );
  const term = captured.instances.at(-1) as XTerm;
  const write = (data: string) => new Promise<void>((r) => term.write(data, r));
  return { ref, sent, handlers, term, write, ...utils };
}

describe("Terminal handle: getText and paste", () => {
  it("getText returns buffer text with logical lines joined by \\n", async () => {
    const { ref, write } = await setup();
    await act(async () => { await write("hello\r\nworld"); });
    expect(ref.current!.getText()).toBe("hello\nworld");
  });

  it("getText honours maxLines", async () => {
    const { ref, write } = await setup();
    await act(async () => { await write("a\r\nb\r\nc"); });
    expect(ref.current!.getText({ maxLines: 2 })).toBe("b\nc");
  });

  it("paste normalises \\n to \\r and reaches the transport like typed input", async () => {
    const { ref, sent } = await setup();
    act(() => { ref.current!.paste("a\nb"); });
    expect(sent).toEqual(["a\rb"]);
  });

  it("paste wraps in bracketed-paste markers once the app enabled DECSET 2004", async () => {
    const { ref, sent, write } = await setup();
    await act(async () => { await write("\x1b[?2004h"); });
    act(() => { ref.current!.paste("x"); });
    expect(sent).toEqual(["\x1b[200~x\x1b[201~"]);
  });

  it("paste of an empty string sends nothing", async () => {
    const { ref, sent } = await setup();
    act(() => { ref.current!.paste(""); });
    expect(sent).toEqual([]);
  });

  it("handle methods are safe after unmount", async () => {
    const { ref, sent, unmount } = await setup();
    const handle = ref.current!;
    unmount();
    expect(() => handle.paste("x")).not.toThrow();
    expect(handle.getText()).toBe("");
    expect(sent).toEqual([]);
  });
});
