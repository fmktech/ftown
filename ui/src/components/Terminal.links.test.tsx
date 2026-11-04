// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { IDisposable, ILink, ILinkProvider, Terminal as XTerm } from "@xterm/xterm";
import type { TerminalHandle } from "@/components/Terminal";
import type { TerminalDataHandlers, TerminalTransportApi } from "@/lib/direct-transport/contract";

const captured = vi.hoisted(() => ({ instances: [] as unknown[], providers: [] as unknown[] }));

vi.mock("@xterm/xterm", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@xterm/xterm")>();
  class CapturedTerminal extends mod.Terminal {
    constructor(...args: ConstructorParameters<typeof mod.Terminal>) {
      super(...args);
      captured.instances.push(this);
    }
    // Record every provider whoever registers it (our code or an addon).
    registerLinkProvider(provider: ILinkProvider): IDisposable {
      captured.providers.push(provider);
      return super.registerLinkProvider(provider);
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
  captured.providers.length = 0;
  vi.restoreAllMocks();
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

const COLS = 80;
const ROW0 = "⏺ https://example.com/ftown/multiline-link-test/0123456789/abcdefghijklmnopqrstu";
const ROW1 = "vwxyz/0123456789/abcdefghijklmnopqrstuvwxyz/path-segment-x?q=END-OF-URL";
const FULL_URL =
  "https://example.com/ftown/multiline-link-test/0123456789/abcdefghijklmnopqrstuvwxyz/0123456789/abcdefghijklmnopqrstuvwxyz/path-segment-x?q=END-OF-URL";

async function setup() {
  const { Terminal } = await import("@/components/Terminal");
  const { transport } = makeTransport();
  const ref = createRef<TerminalHandle>();
  render(<Terminal ref={ref} transport={transport} sessionId="s1" bridgeId="b1" isRunning shellType="claude" />);
  const term = captured.instances.at(-1) as XTerm;
  // jsdom has no layout, so fit leaves the default size; pin it.
  act(() => { term.resize(COLS, 24); });
  const write = (data: string) => new Promise<void>((r) => term.write(data, r));
  return { term, write };
}

/** Links from every registered provider for 1-based buffer row y. */
async function linksAt(y: number): Promise<ILink[]> {
  const providers = captured.providers as ILinkProvider[];
  const results = await Promise.all(
    providers.map((p) => new Promise<ILink[]>((resolve) => {
      p.provideLinks(y, (links) => resolve(links ?? []));
    })),
  );
  return results.flat();
}

/** Activate the link covering cell (x, y), 1-based; returns false when none covers it. */
async function activateAt(x: number, y: number): Promise<boolean> {
  const link = (await linksAt(y)).find(({ range: { start, end } }) => {
    const after = y > start.y || (y === start.y && x >= start.x);
    const before = y < end.y || (y === end.y && x <= end.x);
    return after && before;
  });
  if (!link) return false;
  link.activate(new MouseEvent("click"), link.text);
  return true;
}

describe("Terminal links", () => {
  it("opens the full URL from both rows of a hard-wrapped Claude Code URL", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const { write } = await setup();
    expect(ROW0).toHaveLength(COLS);
    await act(async () => { await write(ROW0 + "\r\x1b[2C\x1b[1B" + ROW1); });

    expect(await activateAt(10, 1)).toBe(true);
    expect(openSpy).toHaveBeenLastCalledWith(FULL_URL, "_blank");

    openSpy.mockClear();
    expect(await activateAt(10, 2)).toBe(true);
    expect(openSpy).toHaveBeenLastCalledWith(FULL_URL, "_blank");
  });

  it("opens a single-row short URL with its exact URL", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const { write } = await setup();
    await act(async () => { await write("see https://example.com/a?b=1 now"); });

    expect(await activateAt(10, 1)).toBe(true);
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith("https://example.com/a?b=1", "_blank");
  });

  it("yields no link on a row without a URL", async () => {
    const { write } = await setup();
    await act(async () => { await write("just some plain words"); });
    expect(await linksAt(1)).toEqual([]);
  });
});
