// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Command, CommandResponse, Session } from '@/types';
import type { MessageClient } from '@/lib/message-client';
import { SessionWorkspace } from './SessionWorkspace';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('reports separator bounds consistently at Home and End for fractional pane limits', () => {
  class TestResizeObserver implements ResizeObserver {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback([{ target, contentRect: DOMRect.fromRect({ width: 655 }), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], this);
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  const session: Session = { id: 'one', bridgeId: 'bridge', name: 'one', status: 'running', createdAt: '', updatedAt: '', preview: { id: '12345678-1234-4234-8234-123456789abc', fileName: 'demo.html' } };
  render(<SessionWorkspace session={session} client={null} userId="user" readable={false} sendCommand={vi.fn()} securityGeneration={0} open onClose={vi.fn()} isDesktop mobileTab="preview" onMobileTab={vi.fn()} onRefit={vi.fn()}><div>Terminal content</div></SessionWorkspace>);
  const separator = screen.getByRole('separator', { name: 'Resize terminal and preview' });
  const values = () => ['aria-valuemin', 'aria-valuenow', 'aria-valuemax'].map(name => Number(separator.getAttribute(name)));
  fireEvent.keyDown(separator, { key: 'Home' });
  let [min, now, max] = values();
  expect(min).toBe(37.1); expect(now).toBe(min); expect(now).toBeLessThanOrEqual(max);
  fireEvent.keyDown(separator, { key: 'End' });
  [min, now, max] = values();
  expect(max).toBe(62.9); expect(now).toBe(max); expect(now).toBeGreaterThanOrEqual(min);
});


it('preserves iframe and terminal nodes through expansion and benign auth checks, and destroys them on batched authority loss', async () => {
  const originalSubtle = Object.getOwnPropertyDescriptor(globalThis.crypto, 'subtle');
  const revision = '9'.repeat(64); const html = '<p>preview</p>';
  Object.defineProperty(globalThis.crypto, 'subtle', { configurable: true, value: { digest: async () => Uint8Array.from({ length: 32 }, () => 0x99).buffer } });
  class TestResizeObserver implements ResizeObserver {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) { this.callback([{ target, contentRect: DOMRect.fromRect({ width: 900 }), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], this); }
    unobserve() {} disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  const endpoint = { version: 1, id: 'bridge-key', ownerId: 'owner', kind: 'bridge', publicKey: 'key' };
  const pin = { bridgeId: 'bridge', endpoint, permissions: ['read'] };
  const listeners = new Set<() => void>(); const accountListeners = new Set<() => void>(); let allowed = true; let status = 'ready';
  const runtime = { identity: { endpoint: { ...endpoint, kind: 'browser', id: 'browser' } }, bridge: () => pin, state: () => ({ status }),
    assertCanSend: () => { if (!allowed) throw new Error('revoked'); }, onChange: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); } };
  const client = { securityRuntime: runtime } as unknown as MessageClient;
  const subscribeAuthority = (listener: () => void) => { accountListeners.add(listener); return () => accountListeners.delete(listener); };
  const pending: Array<(response: CommandResponse) => void> = []; let initial = true;
  const sendCommand = vi.fn((command: Command): Promise<CommandResponse> => {
    if (command.type === 'session_preview_chunk') return Promise.resolve({ requestId: 'c', success: true, data: { state: 'chunk', previewId: '12345678-1234-4234-8234-123456789abc', revision, totalBytes: html.length, offset: 0, dataBase64: btoa(html), done: true } });
    if (initial) { initial = false; return Promise.resolve({ requestId: 's', success: true, data: { state: 'ready', previewId: '12345678-1234-4234-8234-123456789abc', revision, totalBytes: html.length } }); }
    return new Promise(resolve => pending.push(resolve));
  });
  const session: Session = { id: 'one', bridgeId: 'bridge', name: 'one', status: 'running', createdAt: '', updatedAt: '', preview: { id: '12345678-1234-4234-8234-123456789abc', fileName: 'demo.html' } };
  const workspace = (readable: boolean, reviewOpen = false, isDesktop = true, mobileTab: "terminal" | "preview" | "review" = "preview") => <SessionWorkspace session={session} client={client} userId="user" readable={readable} sendCommand={sendCommand} subscribeAuthority={subscribeAuthority} securityGeneration={0} open onClose={vi.fn()} isDesktop={isDesktop} mobileTab={mobileTab} onMobileTab={vi.fn()} onRefit={vi.fn()} reviewOpen={reviewOpen} reviewActivation={reviewOpen ? 1 : 0}><div data-testid="terminal-node">Terminal content</div></SessionWorkspace>;
  const { container, rerender } = render(workspace(true));
  const frame = await screen.findByTitle('HTML preview: demo.html');
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
  const terminal = screen.getByTestId('terminal-node');
  const separator = screen.getByRole('separator', { name: 'Resize terminal and preview' });
  fireEvent.keyDown(separator, { key: 'ArrowRight' });
  const width = terminal.parentElement?.getAttribute('style');
  const expand = screen.getByRole('button', { name: 'Expand preview' }); expand.focus(); fireEvent.click(expand);
  expect(screen.getByRole('button', { name: 'Collapse preview' })).toBe(expand);
  expect(document.activeElement).toBe(expand); expect(terminal.parentElement?.hidden).toBe(true);
  expect(screen.getByTitle('HTML preview: demo.html')).toBe(frame);
  expect(container.querySelector('[role="separator"]')).toBeNull();
  fireEvent.keyDown(expand, { key: 'Escape' });
  expect(screen.getByRole('button', { name: 'Expand preview' })).toBe(expand);
  expect(terminal.parentElement?.hidden).toBe(false); expect(terminal.parentElement?.getAttribute('style')).toBe(width);
  expect(screen.getByTitle('HTML preview: demo.html')).toBe(frame); expect(screen.getByTestId('terminal-node')).toBe(terminal);
  rerender(workspace(true, true));
  expect(screen.getByRole('tab', { name: 'PR review' }).getAttribute('aria-selected')).toBe('true');
  expect(frame.isConnected).toBe(true); expect(screen.getByTestId('terminal-node')).toBe(terminal);
  fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
  expect(screen.getByTitle('HTML preview: demo.html')).toBe(frame);
  fireEvent.keyDown(screen.getByRole('tablist', { name: 'Auxiliary view' }), { key: 'End' });
  expect(screen.getByRole('tab', { name: 'PR review' }).getAttribute('aria-selected')).toBe('true');
  fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
  rerender(workspace(true, true, false, 'review'));
  fireEvent.click(screen.getByRole('button', { name: 'Expand PR review' }));
  rerender(workspace(true, true, false, 'terminal'));
  expect(terminal.parentElement?.hidden).toBe(false);
  expect(frame.isConnected).toBe(true); expect(screen.getByTestId('terminal-node')).toBe(terminal);
  rerender(workspace(true, true, false, 'preview'));
  expect(screen.getByTitle('HTML preview: demo.html')).toBe(frame);
  rerender(workspace(true));
  act(() => listeners.forEach(listener => listener()));
  expect(frame.isConnected).toBe(true); expect(frame.style.visibility).not.toBe('hidden');
  expect(screen.queryByText('Checking preview access…')).toBeNull();
  await act(async () => { pending.shift()!({ requestId: 's2', success: true, data: { state: 'unchanged', previewId: session.preview!.id, revision, totalBytes: html.length } }); });
  await waitFor(() => expect(frame.isConnected).toBe(true));
  expect(screen.getByTitle('HTML preview: demo.html')).toBe(frame);
  act(() => { status = 'offline'; listeners.forEach(listener => listener()); });
  rerender(workspace(false));
  expect(screen.getByTitle('HTML preview: demo.html')).toBe(frame);
  expect(frame.isConnected).toBe(true); expect(frame.style.visibility).not.toBe('hidden');
  expect(screen.queryByText('Reconnect to load preview')).toBeNull();
  act(() => { status = 'connecting'; listeners.forEach(listener => listener()); });
  expect(screen.getByTitle('HTML preview: demo.html')).toBe(frame);
  act(() => { allowed = false; accountListeners.forEach(listener => listener()); allowed = true; accountListeners.forEach(listener => listener()); });
  expect(frame.isConnected).toBe(false);
  if (originalSubtle) Object.defineProperty(globalThis.crypto, 'subtle', originalSubtle); else Reflect.deleteProperty(globalThis.crypto, 'subtle');
});

it('disconnects the old iframe when the timer detects changed permissions while offline without a notification', async () => {
  vi.useFakeTimers();
  const originalSubtle = Object.getOwnPropertyDescriptor(globalThis.crypto, 'subtle');
  Object.defineProperty(globalThis.crypto, 'subtle', { configurable: true, value: { digest: async () => Uint8Array.from({ length: 32 }, () => 0x99).buffer } });
  class TestResizeObserver implements ResizeObserver {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) { this.callback([{ target, contentRect: DOMRect.fromRect({ width: 900 }), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], this); }
    unobserve() {} disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  try {
    const endpoint = { version: 1, id: 'bridge-key', ownerId: 'owner', kind: 'bridge', publicKey: 'key' };
    const pin = { bridgeId: 'bridge', endpoint, permissions: ['read'] };
    const runtime = { identity: { endpoint: { ...endpoint, kind: 'browser', id: 'browser' } }, bridge: () => pin, state: () => ({ status: 'ready' }), assertCanSend: () => {}, onChange: () => () => {} };
    const client = { securityRuntime: runtime } as unknown as MessageClient;
    const html = '<p>preview</p>'; const revision = '9'.repeat(64); const previewId = '12345678-1234-4234-8234-123456789abc';
    const sendCommand = vi.fn(async (command: Command) => ({ requestId: 'x', success: true, data: command.type === 'session_preview_chunk'
      ? { state: 'chunk', previewId, revision, totalBytes: html.length, offset: 0, dataBase64: btoa(html), done: true }
      : { state: 'ready', previewId, revision, totalBytes: html.length } }));
    const session: Session = { id: 'one', bridgeId: 'bridge', name: 'one', status: 'running', createdAt: '', updatedAt: '', preview: { id: previewId, fileName: 'demo.html' } };
    const workspace = (readable: boolean) => <SessionWorkspace session={session} client={client} userId="user" readable={readable} sendCommand={sendCommand} securityGeneration={0} open onClose={vi.fn()} isDesktop mobileTab="preview" onMobileTab={vi.fn()} onRefit={vi.fn()}><div>Terminal</div></SessionWorkspace>;
    const { rerender } = render(workspace(true)); await act(async () => {});
    const frame = screen.getByTitle('HTML preview: demo.html');
    rerender(workspace(false)); expect(frame.isConnected).toBe(true);
    pin.permissions.push('control'); // Still has read, but its authority fingerprint changed.
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(frame.isConnected).toBe(false);
  } finally {
    cleanup(); vi.useRealTimers();
    if (originalSubtle) Object.defineProperty(globalThis.crypto, 'subtle', originalSubtle); else Reflect.deleteProperty(globalThis.crypto, 'subtle');
  }
});

it("provides compact review navigation with roving keyboard selection", () => {
  class TestResizeObserver implements ResizeObserver {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) { this.callback([{ target, contentRect: DOMRect.fromRect({ width: 500 }), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], this); }
    unobserve() {} disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  const session: Session = { id: "one", bridgeId: "bridge", name: "one", status: "running", createdAt: "", updatedAt: "", pullRequestUrl: "https://github.com/owner/repo/pull/1", preview: { id: "12345678-1234-4234-8234-123456789abc", fileName: "demo.html" } };
  render(<SessionWorkspace session={session} client={null} userId="user" readable={false} sendCommand={vi.fn()} securityGeneration={0} open onClose={vi.fn()} isDesktop mobileTab="preview" onMobileTab={vi.fn()} onRefit={vi.fn()} reviewOpen reviewActivation={1}><div>Terminal content</div></SessionWorkspace>);
  const tabs = screen.getByRole("tablist", { name: "Session view" });
  const review = screen.getByRole("tab", { name: "PR review" }); expect(review.getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(tabs, { key: "Home" }); expect(screen.getByRole("tab", { name: "Terminal" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(tabs, { key: "ArrowRight" }); expect(screen.getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(tabs, { key: "End" }); expect(review.getAttribute("aria-selected")).toBe("true");
});

const reviewFixture: Session = { id: 'one', bridgeId: 'bridge', name: 'one', status: 'running', createdAt: '', updatedAt: '', pullRequestUrl: 'https://github.com/owner/repo/pull/1', preview: { id: '12345678-1234-4234-8234-123456789abc', fileName: 'demo.html' } };
function resizeTo(width: number) {
  class TestResizeObserver implements ResizeObserver {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) { this.callback([{ target, contentRect: DOMRect.fromRect({ width }), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], this); }
    unobserve() {} disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
}

it.each([{ width: 900, name: 'wide' }, { width: 500, name: 'compact' }])('$name: closing the selected preview falls back to review, including when expanded', ({ width }) => {
  resizeTo(width);
  const onClose = vi.fn(); const sendCommand = vi.fn(); const onMobileTab = vi.fn(); const onRefit = vi.fn();
  const workspace = (open: boolean) => <SessionWorkspace session={reviewFixture} client={null} userId="user" readable={false} sendCommand={sendCommand} securityGeneration={0} open={open} onClose={onClose} isDesktop mobileTab="preview" onMobileTab={onMobileTab} onRefit={onRefit} reviewOpen reviewActivation={1}><div data-testid="stable-terminal">Terminal content</div></SessionWorkspace>;
  const { rerender } = render(workspace(true));
  const terminal = screen.getByTestId('stable-terminal');
  fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close preview' })); expect(onClose).toHaveBeenCalledTimes(1);
  rerender(workspace(false));
  expect(screen.getByRole('tabpanel', { name: 'PR review' }).hidden).toBe(false);
  expect(screen.getByTestId('stable-terminal')).toBe(terminal);
  if (width < 640) expect(screen.getByRole('tab', { name: 'PR review' }).getAttribute('aria-selected')).toBe('true');
  rerender(workspace(true));
  fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
  fireEvent.click(screen.getByRole('button', { name: 'Expand preview' }));
  expect(terminal.parentElement?.hidden).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
  rerender(workspace(false));
  expect(screen.getByRole('tabpanel', { name: 'PR review' }).hidden).toBe(false);
  expect(screen.getByRole('button', { name: 'Expand PR review' })).toBeTruthy();
  if (width >= 640) expect(terminal.parentElement?.hidden).toBe(false);
});

it.each([900, 500])('preview registration replacement or removal retains selected review at width %i', width => {
  resizeTo(width);
  const sendCommand = vi.fn(); const onMobileTab = vi.fn(); const onRefit = vi.fn();
  const workspace = (session: Session) => <SessionWorkspace session={session} client={null} userId="user" readable={false} sendCommand={sendCommand} securityGeneration={0} open onClose={vi.fn()} isDesktop mobileTab="preview" onMobileTab={onMobileTab} onRefit={onRefit} reviewOpen reviewActivation={1}><div data-testid="stable-terminal">Terminal</div></SessionWorkspace>;
  const { rerender } = render(workspace(reviewFixture));
  const terminal = screen.getByTestId('stable-terminal');
  expect(screen.getByRole('tabpanel', { name: 'PR review' }).hidden).toBe(false);
  rerender(workspace({ ...reviewFixture, preview: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', fileName: 'new.html' } }));
  expect(screen.getByRole('tabpanel', { name: 'PR review' }).hidden).toBe(false);
  rerender(workspace({ ...reviewFixture, preview: undefined }));
  expect(screen.getByRole('tabpanel', { name: 'PR review' }).hidden).toBe(false);
  expect(screen.getByTestId('stable-terminal')).toBe(terminal);
  if (width < 640) expect(screen.getByRole('tab', { name: 'PR review' }).getAttribute('aria-selected')).toBe('true');
});

it('mobile terminal selection collapses either expanded auxiliary view and preserves terminal identity', () => {
  resizeTo(390);
  const sendCommand = vi.fn(); const onMobileTab = vi.fn(); const onRefit = vi.fn();
  const workspace = (mobileTab: 'terminal' | 'preview' | 'review', open = true) => <SessionWorkspace session={reviewFixture} client={null} userId="user" readable={false} sendCommand={sendCommand} securityGeneration={0} open={open} onClose={vi.fn()} isDesktop={false} mobileTab={mobileTab} onMobileTab={onMobileTab} onRefit={onRefit} reviewOpen reviewActivation={1}><div data-testid="stable-terminal">Terminal</div></SessionWorkspace>;
  const { rerender } = render(workspace('review'));
  const terminal = screen.getByTestId('stable-terminal');
  fireEvent.click(screen.getByRole('button', { name: 'Expand PR review' }));
  expect(terminal.parentElement?.hidden).toBe(true);
  rerender(workspace('terminal'));
  expect(terminal.parentElement?.hidden).toBe(false);
  rerender(workspace('review'));
  expect(screen.getByRole('button', { name: 'Expand PR review' })).toBeTruthy();
  rerender(workspace('preview'));
  fireEvent.click(screen.getByRole('button', { name: 'Expand preview' }));
  rerender(workspace('terminal'));
  expect(terminal.parentElement?.hidden).toBe(false);
  expect(screen.getByTestId('stable-terminal')).toBe(terminal);
  rerender(workspace('preview'));
  expect(screen.getByRole('button', { name: 'Expand preview' })).toBeTruthy();
  rerender(workspace('preview', false));
  expect(onMobileTab).toHaveBeenLastCalledWith('review');
  expect(screen.getByRole('tabpanel', { name: 'PR review' }).hidden).toBe(false);
});


it.each([true, false])('closing an expanded review restores preview or terminal when preview open is %s', previewOpen => {
  resizeTo(900);
  const sendCommand = vi.fn(); const onMobileTab = vi.fn(); const onRefit = vi.fn();
  const workspace = (reviewOpen: boolean) => <SessionWorkspace session={reviewFixture} client={null} userId="user" readable={false} sendCommand={sendCommand} securityGeneration={0} open={previewOpen} onClose={vi.fn()} isDesktop mobileTab="preview" onMobileTab={onMobileTab} onRefit={onRefit} reviewOpen={reviewOpen} reviewActivation={1}><div data-testid="stable-terminal">Terminal</div></SessionWorkspace>;
  const { rerender } = render(workspace(true));
  fireEvent.click(screen.getByRole('button', { name: 'Expand PR review' }));
  rerender(workspace(false));
  expect(screen.getByTestId('stable-terminal').parentElement?.hidden).toBe(false);
  if (previewOpen) expect(screen.getByRole('region', { name: 'Session preview' }).hidden).toBe(false);
});

it('mobile closing an expanded preview and selecting review in the same update collapses the fallback', () => {
  resizeTo(390);
  const sendCommand = vi.fn(); const onMobileTab = vi.fn(); const onRefit = vi.fn(); const onClose = vi.fn();
  const workspace = (open: boolean, mobileTab: 'preview' | 'review') => <SessionWorkspace session={reviewFixture} client={null} userId="user" readable={false} sendCommand={sendCommand} securityGeneration={0} open={open} onClose={onClose} isDesktop={false} mobileTab={mobileTab} onMobileTab={onMobileTab} onRefit={onRefit} reviewOpen reviewActivation={1}><div data-testid="stable-terminal">Terminal</div></SessionWorkspace>;
  const { rerender } = render(workspace(true, 'preview'));
  const terminal = screen.getByTestId('stable-terminal');
  fireEvent.click(screen.getByRole('button', { name: 'Expand preview' }));
  expect(terminal.parentElement?.hidden).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  // Dashboard updates the mobile tab and open choice together on close.
  rerender(workspace(false, 'review'));
  expect(screen.getByRole('tabpanel', { name: 'PR review' }).hidden).toBe(false);
  expect(screen.getByRole('button', { name: 'Expand PR review' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Collapse PR review' })).toBeNull();
  expect(screen.getByTestId('stable-terminal')).toBe(terminal);
});

it('removing an inactive preview does not collapse an already expanded review', () => {
  resizeTo(390);
  const sendCommand = vi.fn(); const onMobileTab = vi.fn(); const onRefit = vi.fn();
  const workspace = (open: boolean) => <SessionWorkspace session={reviewFixture} client={null} userId="user" readable={false} sendCommand={sendCommand} securityGeneration={0} open={open} onClose={vi.fn()} isDesktop={false} mobileTab="review" onMobileTab={onMobileTab} onRefit={onRefit} reviewOpen reviewActivation={1}><div>Terminal</div></SessionWorkspace>;
  const { rerender } = render(workspace(true));
  fireEvent.click(screen.getByRole('button', { name: 'Expand PR review' }));
  rerender(workspace(false));
  expect(screen.getByRole('button', { name: 'Collapse PR review' })).toBeTruthy();
});

it('focuses the link confirmation once and keeps user focus across unrelated renders', async () => {
  const originalSubtle = Object.getOwnPropertyDescriptor(globalThis.crypto, 'subtle');
  const revision = '9'.repeat(64); const html = '<p>preview</p>';
  Object.defineProperty(globalThis.crypto, 'subtle', { configurable: true, value: { digest: async () => Uint8Array.from({ length: 32 }, () => 0x99).buffer } });
  class TestResizeObserver implements ResizeObserver {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) { this.callback([{ target, contentRect: DOMRect.fromRect({ width: 900 }), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], this); }
    unobserve() {} disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  const endpoint = { version: 1, id: 'bridge-key', ownerId: 'owner', kind: 'bridge', publicKey: 'key' };
  const pin = { bridgeId: 'bridge', endpoint, permissions: ['read'] };
  const runtime = { identity: { endpoint: { ...endpoint, kind: 'browser', id: 'browser' } }, bridge: () => pin, state: () => ({ status: 'ready' }), assertCanSend: () => {}, onChange: () => () => {} };
  const client = { securityRuntime: runtime } as unknown as MessageClient;
  const previewId = '12345678-1234-4234-8234-123456789abc';
  const sendCommand = vi.fn(async (command: Command) => ({ requestId: 'x', success: true, data: command.type === 'session_preview_chunk'
    ? { state: 'chunk', previewId, revision, totalBytes: html.length, offset: 0, dataBase64: btoa(html), done: true }
    : { state: 'ready', previewId, revision, totalBytes: html.length } }));
  const session: Session = { id: 'one', bridgeId: 'bridge', name: 'one', status: 'running', createdAt: '', updatedAt: '', preview: { id: previewId, fileName: 'demo.html' } };
  const workspace = (generation: number) => <SessionWorkspace session={session} client={client} userId="user" readable sendCommand={sendCommand} securityGeneration={generation} open onClose={vi.fn()} isDesktop mobileTab="preview" onMobileTab={vi.fn()} onRefit={vi.fn()}><div>Terminal</div></SessionWorkspace>;
  try {
    const { rerender } = render(workspace(0));
    await act(async () => {});
    const frame = screen.getByTitle('HTML preview: demo.html') as HTMLIFrameElement;
    const expand = screen.getByRole('button', { name: 'Expand preview' });
    expand.focus(); expect(document.activeElement).toBe(expand);
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: { channel: 'ftown-preview-link-v1', kind: 'open-link', url: 'https://preview.example.test/x' }, source: frame.contentWindow, origin: 'null' })); });
    const prompt = screen.getByRole('dialog', { name: 'Open external link' });
    // Focused once on mount (non-activating container), not the Open button.
    expect(document.activeElement).toBe(prompt);
    const open = screen.getByRole('button', { name: 'Open' });
    open.focus(); expect(document.activeElement).toBe(open);
    // An unrelated render must not move focus back to the dialog.
    rerender(workspace(1));
    expect(document.activeElement).toBe(open);
    // Dismissing restores focus to the element focused before the prompt.
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    expect(screen.queryByRole('dialog', { name: 'Open external link' })).toBeNull();
    expect(document.activeElement).toBe(expand);
    const dispatchLink = () => act(() => { window.dispatchEvent(new MessageEvent('message', { data: { channel: 'ftown-preview-link-v1', kind: 'open-link', url: 'https://preview.example.test/y' }, source: frame.contentWindow, origin: 'null' })); });
    // Escape dismissal also restores focus.
    dispatchLink();
    const escapePrompt = screen.getByRole('dialog', { name: 'Open external link' });
    act(() => { fireEvent.keyDown(escapePrompt, { key: 'Escape' }); });
    expect(screen.queryByRole('dialog', { name: 'Open external link' })).toBeNull();
    expect(document.activeElement).toBe(expand);
    // Confirming opens the frozen target and also restores focus.
    const openSpy = vi.fn();
    vi.stubGlobal('open', openSpy);
    dispatchLink();
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'Open' })); });
    expect(openSpy).toHaveBeenCalledWith('https://preview.example.test/y', '_blank', 'noopener,noreferrer');
    expect(screen.queryByRole('dialog', { name: 'Open external link' })).toBeNull();
    expect(document.activeElement).toBe(expand);
  } finally {
    if (originalSubtle) Object.defineProperty(globalThis.crypto, 'subtle', originalSubtle); else Reflect.deleteProperty(globalThis.crypto, 'subtle');
  }
});
