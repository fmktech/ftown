// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Command, CommandResponse, Session } from '@/types';
import type { MessageClient } from '@/lib/message-client';
import { SessionWorkspace } from './SessionWorkspace';
import { PREVIEW_CSP } from '@/lib/session-preview';

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
  const session: Session = { id: 'one', bridgeId: 'bridge', name: 'one', status: 'running', createdAt: '', updatedAt: '', preview: { id: '12345678-1234-4234-8234-123456789abc', files: [{ id: '22345678-2234-4234-8234-123456789abc', fileName: 'demo.html', kind: 'html' }] } };
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
    if (command.type === 'session_preview_chunk') return Promise.resolve({ requestId: 'c', success: true, data: { state: 'chunk', previewId: '12345678-1234-4234-8234-123456789abc', fileId: '22345678-2234-4234-8234-123456789abc', revision, totalBytes: html.length, offset: 0, dataBase64: btoa(html), done: true } });
    if (initial) { initial = false; return Promise.resolve({ requestId: 's', success: true, data: { state: 'ready', previewId: '12345678-1234-4234-8234-123456789abc', fileId: '22345678-2234-4234-8234-123456789abc', revision, totalBytes: html.length } }); }
    return new Promise(resolve => pending.push(resolve));
  });
  const session: Session = { id: 'one', bridgeId: 'bridge', name: 'one', status: 'running', createdAt: '', updatedAt: '', preview: { id: '12345678-1234-4234-8234-123456789abc', files: [{ id: '22345678-2234-4234-8234-123456789abc', fileName: 'demo.html', kind: 'html' }] } };
  const workspace = (readable: boolean, reviewOpen = false, isDesktop = true, mobileTab: "terminal" | "preview" | "review" = "preview") => <SessionWorkspace session={session} client={client} userId="user" readable={readable} sendCommand={sendCommand} subscribeAuthority={subscribeAuthority} securityGeneration={0} open onClose={vi.fn()} isDesktop={isDesktop} mobileTab={mobileTab} onMobileTab={vi.fn()} onRefit={vi.fn()} reviewOpen={reviewOpen} reviewActivation={reviewOpen ? 1 : 0}><div data-testid="terminal-node">Terminal content</div></SessionWorkspace>;
  const { container, rerender } = render(workspace(true));
  const frame = await screen.findByTitle('Preview: demo.html');
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
  const terminal = screen.getByTestId('terminal-node');
  const separator = screen.getByRole('separator', { name: 'Resize terminal and preview' });
  fireEvent.keyDown(separator, { key: 'ArrowRight' });
  const width = terminal.parentElement?.getAttribute('style');
  const expand = screen.getByRole('button', { name: 'Expand preview' }); expand.focus(); fireEvent.click(expand);
  expect(screen.getByRole('button', { name: 'Collapse preview' })).toBe(expand);
  expect(document.activeElement).toBe(expand); expect(terminal.parentElement?.hidden).toBe(true);
  expect(screen.getByTitle('Preview: demo.html')).toBe(frame);
  expect(container.querySelector('[role="separator"]')).toBeNull();
  fireEvent.keyDown(expand, { key: 'Escape' });
  expect(screen.getByRole('button', { name: 'Expand preview' })).toBe(expand);
  expect(terminal.parentElement?.hidden).toBe(false); expect(terminal.parentElement?.getAttribute('style')).toBe(width);
  expect(screen.getByTitle('Preview: demo.html')).toBe(frame); expect(screen.getByTestId('terminal-node')).toBe(terminal);
  rerender(workspace(true, true));
  expect(screen.getByRole('tab', { name: 'PR review' }).getAttribute('aria-selected')).toBe('true');
  expect(frame.isConnected).toBe(true); expect(screen.getByTestId('terminal-node')).toBe(terminal);
  fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
  expect(screen.getByTitle('Preview: demo.html')).toBe(frame);
  fireEvent.keyDown(screen.getByRole('tablist', { name: 'Auxiliary view' }), { key: 'End' });
  expect(screen.getByRole('tab', { name: 'PR review' }).getAttribute('aria-selected')).toBe('true');
  fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
  rerender(workspace(true, true, false, 'review'));
  fireEvent.click(screen.getByRole('button', { name: 'Expand PR review' }));
  rerender(workspace(true, true, false, 'terminal'));
  expect(terminal.parentElement?.hidden).toBe(false);
  expect(frame.isConnected).toBe(true); expect(screen.getByTestId('terminal-node')).toBe(terminal);
  rerender(workspace(true, true, false, 'preview'));
  expect(screen.getByTitle('Preview: demo.html')).toBe(frame);
  rerender(workspace(true));
  act(() => listeners.forEach(listener => listener()));
  expect(frame.isConnected).toBe(true); expect(frame.style.visibility).not.toBe('hidden');
  expect(screen.queryByText('Checking preview access…')).toBeNull();
  await act(async () => { pending.shift()!({ requestId: 's2', success: true, data: { state: 'unchanged', previewId: session.preview!.id, fileId: '22345678-2234-4234-8234-123456789abc', revision, totalBytes: html.length } }); });
  await waitFor(() => expect(frame.isConnected).toBe(true));
  expect(screen.getByTitle('Preview: demo.html')).toBe(frame);
  act(() => { status = 'offline'; listeners.forEach(listener => listener()); });
  rerender(workspace(false));
  expect(screen.getByTitle('Preview: demo.html')).toBe(frame);
  expect(frame.isConnected).toBe(true); expect(frame.style.visibility).not.toBe('hidden');
  expect(screen.queryByText('Reconnect to load preview')).toBeNull();
  act(() => { status = 'connecting'; listeners.forEach(listener => listener()); });
  expect(screen.getByTitle('Preview: demo.html')).toBe(frame);
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
    const html = '<p>preview</p>'; const revision = '9'.repeat(64); const previewId = '12345678-1234-4234-8234-123456789abc'; const fileId = '22345678-2234-4234-8234-123456789abc';
    const sendCommand = vi.fn(async (command: Command) => ({ requestId: 'x', success: true, data: command.type === 'session_preview_chunk'
      ? { state: 'chunk', previewId, fileId, revision, totalBytes: html.length, offset: 0, dataBase64: btoa(html), done: true }
      : { state: 'ready', previewId, fileId, revision, totalBytes: html.length } }));
    const session: Session = { id: 'one', bridgeId: 'bridge', name: 'one', status: 'running', createdAt: '', updatedAt: '', preview: { id: previewId, files: [{ id: fileId, fileName: 'demo.html', kind: 'html' }] } };
    const workspace = (readable: boolean) => <SessionWorkspace session={session} client={client} userId="user" readable={readable} sendCommand={sendCommand} securityGeneration={0} open onClose={vi.fn()} isDesktop mobileTab="preview" onMobileTab={vi.fn()} onRefit={vi.fn()}><div>Terminal</div></SessionWorkspace>;
    const { rerender } = render(workspace(true)); await act(async () => {});
    const frame = screen.getByTitle('Preview: demo.html');
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
  const session: Session = { id: "one", bridgeId: "bridge", name: "one", status: "running", createdAt: "", updatedAt: "", pullRequestUrl: "https://github.com/owner/repo/pull/1", preview: { id: "12345678-1234-4234-8234-123456789abc", files: [{ id: "22345678-2234-4234-8234-123456789abc", fileName: "demo.html", kind: "html" }] } };
  render(<SessionWorkspace session={session} client={null} userId="user" readable={false} sendCommand={vi.fn()} securityGeneration={0} open onClose={vi.fn()} isDesktop mobileTab="preview" onMobileTab={vi.fn()} onRefit={vi.fn()} reviewOpen reviewActivation={1}><div>Terminal content</div></SessionWorkspace>);
  const tabs = screen.getByRole("tablist", { name: "Session view" });
  const review = screen.getByRole("tab", { name: "PR review" }); expect(review.getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(tabs, { key: "Home" }); expect(screen.getByRole("tab", { name: "Terminal" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(tabs, { key: "ArrowRight" }); expect(screen.getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(tabs, { key: "End" }); expect(review.getAttribute("aria-selected")).toBe("true");
});

const reviewFixture: Session = { id: 'one', bridgeId: 'bridge', name: 'one', status: 'running', createdAt: '', updatedAt: '', pullRequestUrl: 'https://github.com/owner/repo/pull/1', preview: { id: '12345678-1234-4234-8234-123456789abc', files: [{ id: '22345678-2234-4234-8234-123456789abc', fileName: 'demo.html', kind: 'html' }] } };
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
  rerender(workspace({ ...reviewFixture, preview: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', files: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', fileName: 'new.html', kind: 'html' }] } }));
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
    ? { state: 'chunk', previewId, fileId: '22345678-2234-4234-8234-123456789abc', revision, totalBytes: html.length, offset: 0, dataBase64: btoa(html), done: true }
    : { state: 'ready', previewId, fileId: '22345678-2234-4234-8234-123456789abc', revision, totalBytes: html.length } }));
  const session: Session = { id: 'one', bridgeId: 'bridge', name: 'one', status: 'running', createdAt: '', updatedAt: '', preview: { id: previewId, files: [{ id: '22345678-2234-4234-8234-123456789abc', fileName: 'demo.html', kind: 'html' }] } };
  const workspace = (generation: number) => <SessionWorkspace session={session} client={client} userId="user" readable sendCommand={sendCommand} securityGeneration={generation} open onClose={vi.fn()} isDesktop mobileTab="preview" onMobileTab={vi.fn()} onRefit={vi.fn()}><div>Terminal</div></SessionWorkspace>;
  try {
    const { rerender } = render(workspace(0));
    await act(async () => {});
    const frame = screen.getByTitle('Preview: demo.html') as HTMLIFrameElement;
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

// SPEC-A multi-file selector

function makeFile(idSuffix: string, fileName: string, kind: 'html' | 'markdown') {
  return { id: `40000000-4000-4000-8000-${idSuffix.padStart(12, '0').slice(-12)}`, fileName, kind };
}
function uuid(id: string) { return id; }

it('shows no selector for a single file', () => {
  resizeTo(900);
  const session: Session = {
    id: 'one', bridgeId: 'bridge', name: 'one', status: 'running', createdAt: '', updatedAt: '',
    preview: { id: '12345678-1234-4234-8234-123456789abc', files: [{ id: '22345678-2234-4234-8234-123456789abc', fileName: 'demo.html', kind: 'html' }] },
  };
  render(<SessionWorkspace session={session} client={null} userId="user" readable={false} sendCommand={vi.fn()} securityGeneration={0} open onClose={vi.fn()} isDesktop mobileTab="preview" onMobileTab={vi.fn()} onRefit={vi.fn()}><div>Terminal</div></SessionWorkspace>);
  expect(screen.getByText('demo.html')).toBeTruthy();
  expect(screen.queryByLabelText('Preview file')).toBeNull();
  expect(screen.queryByRole('tablist', { name: 'Preview file' })).toBeNull();
});

it('shows a tablist for 2-4 files with aria-selected and title ellipsis', () => {
  resizeTo(900);
  const session: Session = {
    id: 'one', bridgeId: 'bridge', name: 'one', status: 'running', createdAt: '', updatedAt: '',
    preview: {
      id: '12345678-1234-4234-8234-123456789abc',
      files: [
        { id: '40000000-4000-4000-8000-000000000001', fileName: 'a.html', kind: 'html' },
        { id: '40000000-4000-4000-8000-000000000002', fileName: 'very-long-file-name-that-should-ellipsis.md', kind: 'markdown' },
        { id: '40000000-4000-4000-8000-000000000003', fileName: 'c.html', kind: 'html' },
      ],
    },
  };
  render(<SessionWorkspace session={session} client={null} userId="user" readable={false} sendCommand={vi.fn()} securityGeneration={0} open onClose={vi.fn()} isDesktop mobileTab="preview" onMobileTab={vi.fn()} onRefit={vi.fn()}><div>Terminal</div></SessionWorkspace>);
  const list = screen.getByRole('tablist', { name: 'Preview file' });
  expect(list).toBeTruthy();
  const tabs = within(list).getAllByRole('tab');
  expect(tabs).toHaveLength(3);
  expect(tabs[0].getAttribute('aria-selected')).toBe('true');
  expect(tabs[1].getAttribute('aria-selected')).toBe('false');
  expect(tabs[1].getAttribute('title')).toBe('very-long-file-name-that-should-ellipsis.md');
  expect(tabs[1].textContent).toBe('very-long-file-name-that-should-ellipsis.md');
  // keyboard accessible: tab buttons are focusable and selectable via Enter/space (implicit) + arrow nav
  tabs[1].focus();
  fireEvent.keyDown(list, { key: 'ArrowRight' });
  // after arrow, focus moves and click occurs via our handler, so selection should update
  // Our handler clicks the next tab, so c.html should become selected after another arrow from focused element
  // Verify at least one selection change via direct click
  fireEvent.click(tabs[1]);
  expect(tabs[1].getAttribute('aria-selected')).toBe('true');
  expect(tabs[0].getAttribute('aria-selected')).toBe('false');
});

it('shows a native select for 5+ files', () => {
  resizeTo(900);
  const session: Session = {
    id: 'one', bridgeId: 'bridge', name: 'one', status: 'running', createdAt: '', updatedAt: '',
    preview: {
      id: '12345678-1234-4234-8234-123456789abc',
      files: [
        { id: '40000000-4000-4000-8000-000000000001', fileName: 'a.html', kind: 'html' },
        { id: '40000000-4000-4000-8000-000000000002', fileName: 'b.html', kind: 'html' },
        { id: '40000000-4000-4000-8000-000000000003', fileName: 'c.html', kind: 'html' },
        { id: '40000000-4000-4000-8000-000000000004', fileName: 'd.html', kind: 'html' },
        { id: '40000000-4000-4000-8000-000000000005', fileName: 'e.html', kind: 'html' },
      ],
    },
  };
  render(<SessionWorkspace session={session} client={null} userId="user" readable={false} sendCommand={vi.fn()} securityGeneration={0} open onClose={vi.fn()} isDesktop mobileTab="preview" onMobileTab={vi.fn()} onRefit={vi.fn()}><div>Terminal</div></SessionWorkspace>);
  const select = screen.getByLabelText('Preview file') as HTMLSelectElement;
  expect(select.tagName).toBe('SELECT');
  expect(select.value).toBe('a.html');
  fireEvent.change(select, { target: { value: 'c.html' } });
  expect(select.value).toBe('c.html');
});

it('keeps selection by fileName across set change even with new file id, and selects newly added file', () => {
  resizeTo(900);
  const sendCommand = vi.fn();
  const { rerender } = render(
    <SessionWorkspace
      session={{
        id: 'one', bridgeId: 'bridge', name: 'one', status: 'running', createdAt: '', updatedAt: '',
        preview: {
          id: '11111111-1111-4111-8111-111111111111',
          files: [
            { id: '40000000-4000-4000-8000-000000000001', fileName: 'a.html', kind: 'html' },
            { id: '40000000-4000-4000-8000-000000000002', fileName: 'b.html', kind: 'html' },
          ],
        },
      }}
      client={null} userId="user" readable={false} sendCommand={sendCommand} securityGeneration={0} open onClose={vi.fn()} isDesktop mobileTab="preview" onMobileTab={vi.fn()} onRefit={vi.fn()}
    ><div>Terminal</div></SessionWorkspace>
  );
  let list = screen.getByRole('tablist', { name: 'Preview file' });
  let tabs = within(list).getAllByRole('tab');
  fireEvent.click(tabs[1]); // select b.html
  expect(tabs[1].getAttribute('aria-selected')).toBe('true');

  // set change: new set id, same fileNames but new file ids
  rerender(
    <SessionWorkspace
      session={{
        id: 'one', bridgeId: 'bridge', name: 'one', status: 'running', createdAt: '', updatedAt: '',
        preview: {
          id: '22222222-2222-4222-8222-222222222222',
          files: [
            { id: '40000000-4000-4000-8000-000000000011', fileName: 'a.html', kind: 'html' },
            { id: '40000000-4000-4000-8000-000000000012', fileName: 'b.html', kind: 'html' },
          ],
        },
      }}
      client={null} userId="user" readable={false} sendCommand={sendCommand} securityGeneration={0} open onClose={vi.fn()} isDesktop mobileTab="preview" onMobileTab={vi.fn()} onRefit={vi.fn()}
    ><div>Terminal</div></SessionWorkspace>
  );
  list = screen.getByRole('tablist', { name: 'Preview file' });
  tabs = within(list).getAllByRole('tab');
  expect(tabs[1].getAttribute('aria-selected')).toBe('true');
  expect(tabs[0].getAttribute('aria-selected')).toBe('false');

  // addition via --add: introduce c.html not previously seen
  rerender(
    <SessionWorkspace
      session={{
        id: 'one', bridgeId: 'bridge', name: 'one', status: 'running', createdAt: '', updatedAt: '',
        preview: {
          id: '33333333-3333-4333-8333-333333333333',
          files: [
            { id: '40000000-4000-4000-8000-000000000011', fileName: 'a.html', kind: 'html' },
            { id: '40000000-4000-4000-8000-000000000012', fileName: 'b.html', kind: 'html' },
            { id: '40000000-4000-4000-8000-000000000013', fileName: 'c.html', kind: 'html' },
          ],
        },
      }}
      client={null} userId="user" readable={false} sendCommand={sendCommand} securityGeneration={0} open onClose={vi.fn()} isDesktop mobileTab="preview" onMobileTab={vi.fn()} onRefit={vi.fn()}
    ><div>Terminal</div></SessionWorkspace>
  );
  list = screen.getByRole('tablist', { name: 'Preview file' });
  tabs = within(list).getAllByRole('tab');
  expect(tabs[2].getAttribute('aria-selected')).toBe('true');
  expect(tabs[0].getAttribute('aria-selected')).toBe('false');
  expect(tabs[1].getAttribute('aria-selected')).toBe('false');

  // removal of selected file falls back to first
  rerender(
    <SessionWorkspace
      session={{
        id: 'one', bridgeId: 'bridge', name: 'one', status: 'running', createdAt: '', updatedAt: '',
        preview: {
          id: '44444444-4444-4444-8444-444444444444',
          files: [
            { id: '40000000-4000-4000-8000-000000000011', fileName: 'a.html', kind: 'html' },
            { id: '40000000-4000-4000-8000-000000000012', fileName: 'b.html', kind: 'html' },
          ],
        },
      }}
      client={null} userId="user" readable={false} sendCommand={sendCommand} securityGeneration={0} open onClose={vi.fn()} isDesktop mobileTab="preview" onMobileTab={vi.fn()} onRefit={vi.fn()}
    ><div>Terminal</div></SessionWorkspace>
  );
  list = screen.getByRole('tablist', { name: 'Preview file' });
  tabs = within(list).getAllByRole('tab');
  expect(tabs[0].getAttribute('aria-selected')).toBe('true');
});

it('switching files shows loading never stale content and markdown vs HTML srcDoc branch', async () => {
  resizeTo(900);
  const originalSubtle = Object.getOwnPropertyDescriptor(globalThis.crypto, 'subtle');
  Object.defineProperty(globalThis.crypto, 'subtle', { configurable: true, value: { digest: async (_alg: string, bytes: Uint8Array) => {
    void _alg;
    const text = new TextDecoder().decode(bytes);
    const byte = text.includes('first') ? 0xaa : 0xbb;
    return Uint8Array.from({ length: 32 }, () => byte).buffer;
  } } });
  const htmlContent = '<p>first</p>'; const mdContent = '# Heading\n\n| A | B |\n|---|---|';
  const revisionHtml = 'a'.repeat(64); const revisionMd = 'b'.repeat(64);
  const sendCommand = vi.fn((command: Command): Promise<CommandResponse> => {
    const payload = command.payload as Record<string, unknown>;
    const fileId = typeof payload.fileId === 'string' ? payload.fileId : '';
    const isHtml = fileId === '40000000-4000-4000-8000-000000000001';
    const text = isHtml ? htmlContent : mdContent;
    const rev = isHtml ? revisionHtml : revisionMd;
    if (command.type === 'session_preview_chunk') {
      return Promise.resolve({ requestId: 'c', success: true, data: { state: 'chunk', previewId: '12345678-1234-4234-8234-123456789abc', fileId, revision: rev, totalBytes: text.length, offset: 0, dataBase64: btoa(text), done: true } });
    }
    return Promise.resolve({ requestId: 's', success: true, data: { state: 'ready', previewId: '12345678-1234-4234-8234-123456789abc', fileId, revision: rev, totalBytes: text.length } });
  });
  const session: Session = {
    id: 'one', bridgeId: 'bridge', name: 'one', status: 'running', createdAt: '', updatedAt: '',
    preview: {
      id: '12345678-1234-4234-8234-123456789abc',
      files: [
        { id: '40000000-4000-4000-8000-000000000001', fileName: 'a.html', kind: 'html' },
        { id: '40000000-4000-4000-8000-000000000002', fileName: 'notes.md', kind: 'markdown' },
      ],
    },
  };
  render(
    <SessionWorkspace session={session} client={{} as unknown as MessageClient} userId="user" readable={true} sendCommand={sendCommand} securityGeneration={0} open onClose={vi.fn()} isDesktop mobileTab="preview" onMobileTab={vi.fn()} onRefit={vi.fn()}><div>Terminal</div></SessionWorkspace>
  );
  // first file loads html
  const frame = await screen.findByTitle('Preview: a.html');
  const srcDoc = frame.getAttribute('srcdoc') ?? '';
  expect(srcDoc).toContain(PREVIEW_CSP);
  expect(srcDoc).toContain('first');
  expect(srcDoc).toContain('a.html');
  // switch to markdown
  const list = screen.getByRole('tablist', { name: 'Preview file' });
  const mdTab = within(list).getByRole('tab', { name: 'notes.md' });
  fireEvent.click(mdTab);
  // while loading, stale content should not be visible: iframe disappears and loading message appears, or at least not show previous html under new name
  expect(screen.queryByTitle('Preview: a.html')).toBeNull();
  const mdFrame = await screen.findByTitle('Preview: notes.md');
  const mdSrcDoc = mdFrame.getAttribute('srcdoc') ?? '';
  expect(mdSrcDoc).toContain(PREVIEW_CSP);
  expect(mdSrcDoc).toContain('Heading');
  // markdown document should contain markdownDocument structure (doctype, heading)
  expect(mdSrcDoc).toContain('<h1');
  if (originalSubtle) Object.defineProperty(globalThis.crypto, 'subtle', originalSubtle); else Reflect.deleteProperty(globalThis.crypto, 'subtle');
});

it('relative link to registered file switches selection via onSwitchFile', async () => {
  resizeTo(900);
  const originalSubtle = Object.getOwnPropertyDescriptor(globalThis.crypto, 'subtle');
  Object.defineProperty(globalThis.crypto, 'subtle', { configurable: true, value: { digest: async () => Uint8Array.from({ length: 32 }, () => 0x99).buffer } });
  const html = '<p>preview</p>'; const revision = '9'.repeat(64);
  const sendCommand = vi.fn(async (command: Command) => ({ requestId: 'x', success: true, data: command.type === 'session_preview_chunk'
    ? { state: 'chunk', previewId: '12345678-1234-4234-8234-123456789abc', fileId: (command.payload as Record<string, unknown>).fileId, revision, totalBytes: html.length, offset: 0, dataBase64: btoa(html), done: true }
    : { state: 'ready', previewId: '12345678-1234-4234-8234-123456789abc', fileId: (command.payload as Record<string, unknown>).fileId, revision, totalBytes: html.length } }));
  const session: Session = {
    id: 'one', bridgeId: 'bridge', name: 'one', status: 'running', createdAt: '', updatedAt: '',
    preview: {
      id: '12345678-1234-4234-8234-123456789abc',
      files: [
        { id: '40000000-4000-4000-8000-000000000001', fileName: 'a.html', kind: 'html' },
        { id: '40000000-4000-4000-8000-000000000002', fileName: 'notes.md', kind: 'markdown' },
      ],
    },
  };
  render(<SessionWorkspace session={session} client={{} as unknown as MessageClient} userId="user" readable={true} sendCommand={sendCommand} securityGeneration={0} open onClose={vi.fn()} isDesktop mobileTab="preview" onMobileTab={vi.fn()} onRefit={vi.fn()}><div>Terminal</div></SessionWorkspace>);
  const frame = await screen.findByTitle('Preview: a.html') as HTMLIFrameElement;
  // simulate iframe posting switch-file
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { channel: 'ftown-preview-link-v1', kind: 'switch-file', fileName: 'notes.md' }, source: frame.contentWindow, origin: 'null' }));
  });
  const list = screen.getByRole('tablist', { name: 'Preview file' });
  const mdTab = within(list).getByRole('tab', { name: 'notes.md' });
  expect(mdTab.getAttribute('aria-selected')).toBe('true');
  const aTab = within(list).getByRole('tab', { name: 'a.html' });
  expect(aTab.getAttribute('aria-selected')).toBe('false');
  if (originalSubtle) Object.defineProperty(globalThis.crypto, 'subtle', originalSubtle); else Reflect.deleteProperty(globalThis.crypto, 'subtle');
});

it('ignores switch-file for an unregistered file and keeps the current selection', async () => {
  resizeTo(900);
  const originalSubtle = Object.getOwnPropertyDescriptor(globalThis.crypto, 'subtle');
  Object.defineProperty(globalThis.crypto, 'subtle', { configurable: true, value: { digest: async () => Uint8Array.from({ length: 32 }, () => 0x99).buffer } });
  const html = '<p>preview</p>'; const revision = '9'.repeat(64);
  const sendCommand = vi.fn(async (command: Command) => ({ requestId: 'x', success: true, data: command.type === 'session_preview_chunk'
    ? { state: 'chunk', previewId: '12345678-1234-4234-8234-123456789abc', fileId: (command.payload as Record<string, unknown>).fileId, revision, totalBytes: html.length, offset: 0, dataBase64: btoa(html), done: true }
    : { state: 'ready', previewId: '12345678-1234-4234-8234-123456789abc', fileId: (command.payload as Record<string, unknown>).fileId, revision, totalBytes: html.length } }));
  const session: Session = {
    id: 'one', bridgeId: 'bridge', name: 'one', status: 'running', createdAt: '', updatedAt: '',
    preview: {
      id: '12345678-1234-4234-8234-123456789abc',
      files: [
        { id: '40000000-4000-4000-8000-000000000001', fileName: 'a.html', kind: 'html' },
        { id: '40000000-4000-4000-8000-000000000002', fileName: 'notes.md', kind: 'markdown' },
      ],
    },
  };
  render(<SessionWorkspace session={session} client={{} as unknown as MessageClient} userId="user" readable={true} sendCommand={sendCommand} securityGeneration={0} open onClose={vi.fn()} isDesktop mobileTab="preview" onMobileTab={vi.fn()} onRefit={vi.fn()}><div>Terminal</div></SessionWorkspace>);
  await screen.findByTitle('Preview: a.html');
  // Start on the second file so a broken match check (which would store the
  // unknown name and fall back to the first file) is observable.
  const list = screen.getByRole('tablist', { name: 'Preview file' });
  fireEvent.click(within(list).getByRole('tab', { name: 'notes.md' }));
  const mdFrame = await screen.findByTitle('Preview: notes.md') as HTMLIFrameElement;
  expect(within(screen.getByRole('tablist', { name: 'Preview file' })).getByRole('tab', { name: 'notes.md' }).getAttribute('aria-selected')).toBe('true');
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { channel: 'ftown-preview-link-v1', kind: 'switch-file', fileName: 'missing.md' }, source: mdFrame.contentWindow, origin: 'null' }));
  });
  const after = screen.getByRole('tablist', { name: 'Preview file' });
  expect(within(after).getByRole('tab', { name: 'notes.md' }).getAttribute('aria-selected')).toBe('true');
  expect(within(after).getByRole('tab', { name: 'a.html' }).getAttribute('aria-selected')).toBe('false');
  expect(screen.getByTitle('Preview: notes.md')).toBe(mdFrame);
  if (originalSubtle) Object.defineProperty(globalThis.crypto, 'subtle', originalSubtle); else Reflect.deleteProperty(globalThis.crypto, 'subtle');
});

it('remembers the selected file per session across session switches while mounted', async () => {
  resizeTo(900);
  const originalSubtle = Object.getOwnPropertyDescriptor(globalThis.crypto, 'subtle');
  Object.defineProperty(globalThis.crypto, 'subtle', { configurable: true, value: { digest: async () => Uint8Array.from({ length: 32 }, () => 0x99).buffer } });
  const html = '<p>preview</p>'; const revision = '9'.repeat(64);
  const client = {} as unknown as MessageClient;
  const sendCommand = vi.fn((command: Command): Promise<CommandResponse> => {
    const payload = command.payload as Record<string, unknown>;
    const previewId = typeof payload.previewId === 'string' ? payload.previewId : '';
    const fileId = typeof payload.fileId === 'string' ? payload.fileId : '';
    if (command.type === 'session_preview_chunk') {
      return Promise.resolve({ requestId: 'c', success: true, data: { state: 'chunk', previewId, fileId, revision, totalBytes: html.length, offset: 0, dataBase64: btoa(html), done: true } });
    }
    return Promise.resolve({ requestId: 's', success: true, data: { state: 'ready', previewId, fileId, revision, totalBytes: html.length } });
  });
  const sessionA: Session = {
    id: 'one', bridgeId: 'bridge', name: 'one', status: 'running', createdAt: '', updatedAt: '',
    preview: {
      id: '11111111-1111-4111-8111-111111111111',
      files: [
        { id: '40000000-4000-4000-8000-000000000001', fileName: 'a.html', kind: 'html' },
        { id: '40000000-4000-4000-8000-000000000002', fileName: 'notes.md', kind: 'markdown' },
      ],
    },
  };
  const sessionB: Session = {
    id: 'two', bridgeId: 'bridge', name: 'two', status: 'running', createdAt: '', updatedAt: '',
    preview: {
      id: '22222222-2222-4222-8222-222222222222',
      files: [
        { id: '40000000-4000-4000-8000-000000000003', fileName: 'x.html', kind: 'html' },
        { id: '40000000-4000-4000-8000-000000000004', fileName: 'y.md', kind: 'markdown' },
      ],
    },
  };
  const workspace = (session: Session) => <SessionWorkspace session={session} client={client} userId="user" readable={true} sendCommand={sendCommand} securityGeneration={0} open onClose={vi.fn()} isDesktop mobileTab="preview" onMobileTab={vi.fn()} onRefit={vi.fn()}><div>Terminal</div></SessionWorkspace>;
  const { rerender } = render(workspace(sessionA));
  await screen.findByTitle('Preview: a.html');
  fireEvent.click(within(screen.getByRole('tablist', { name: 'Preview file' })).getByRole('tab', { name: 'notes.md' }));
  await screen.findByTitle('Preview: notes.md');
  expect(within(screen.getByRole('tablist', { name: 'Preview file' })).getByRole('tab', { name: 'notes.md' }).getAttribute('aria-selected')).toBe('true');
  rerender(workspace(sessionB));
  await screen.findByTitle('Preview: x.html');
  const listB = screen.getByRole('tablist', { name: 'Preview file' });
  expect(within(listB).getByRole('tab', { name: 'x.html' }).getAttribute('aria-selected')).toBe('true');
  expect(within(listB).getByRole('tab', { name: 'y.md' }).getAttribute('aria-selected')).toBe('false');
  rerender(workspace(sessionA));
  await screen.findByTitle('Preview: notes.md');
  const listBack = screen.getByRole('tablist', { name: 'Preview file' });
  expect(within(listBack).getByRole('tab', { name: 'notes.md' }).getAttribute('aria-selected')).toBe('true');
  expect(within(listBack).getByRole('tab', { name: 'a.html' }).getAttribute('aria-selected')).toBe('false');
  if (originalSubtle) Object.defineProperty(globalThis.crypto, 'subtle', originalSubtle); else Reflect.deleteProperty(globalThis.crypto, 'subtle');
});

it('treats old bridge shape without files as no preview', () => {
  resizeTo(900);
  const session = { id: 'one', bridgeId: 'bridge', name: 'one', status: 'running', createdAt: '', updatedAt: '', preview: { id: '12345678-1234-4234-8234-123456789abc', fileName: 'demo.html' } } as unknown as Session;
  render(<SessionWorkspace session={session} client={null} userId="user" readable={false} sendCommand={vi.fn()} securityGeneration={0} open onClose={vi.fn()} isDesktop mobileTab="preview" onMobileTab={vi.fn()} onRefit={vi.fn()}><div>Terminal</div></SessionWorkspace>);
  expect(screen.queryByLabelText('Session preview')).toBeNull();
  expect(screen.queryByRole('region', { name: 'Session preview' })).toBeNull();
  expect(screen.queryByText('Loading preview…')).toBeNull();
});

it('error shows file name of selected file', async () => {
  resizeTo(900);
  const sendCommand = vi.fn(async () => ({ requestId: 'x', success: false, data: { code: 'unknown' } }));
  const session: Session = {
    id: 'one', bridgeId: 'bridge', name: 'one', status: 'running', createdAt: '', updatedAt: '',
    preview: {
      id: '12345678-1234-4234-8234-123456789abc',
      files: [
        { id: '40000000-4000-4000-8000-000000000001', fileName: 'a.html', kind: 'html' },
        { id: '40000000-4000-4000-8000-000000000002', fileName: 'b.html', kind: 'html' },
      ],
    },
  };
  render(<SessionWorkspace session={session} client={{} as unknown as MessageClient} userId="user" readable={true} sendCommand={sendCommand} securityGeneration={0} open onClose={vi.fn()} isDesktop mobileTab="preview" onMobileTab={vi.fn()} onRefit={vi.fn()}><div>Terminal</div></SessionWorkspace>);
  const list = screen.getByRole('tablist', { name: 'Preview file' });
  expect(list).toBeTruthy();
  // error state shows Retry and file-related message including the selected file name
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy());
  const status = screen.getByRole('status');
  expect(status.querySelector('span')?.textContent).toBe('a.html is unavailable');
  // selected file name is in the tablist
  expect(within(list).getByRole('tab', { name: 'a.html' }).getAttribute('aria-selected')).toBe('true');
});

it('first registration of two files selects the first file', () => {
  resizeTo(900);
  const sendCommand = vi.fn();
  const baseSession = { id: 'one', bridgeId: 'bridge', name: 'one', status: 'running', createdAt: '', updatedAt: '' } as Session;
  const workspace = (session: Session) => <SessionWorkspace session={session} client={null} userId="user" readable={false} sendCommand={sendCommand} securityGeneration={0} open onClose={vi.fn()} isDesktop mobileTab="preview" onMobileTab={vi.fn()} onRefit={vi.fn()}><div>Terminal</div></SessionWorkspace>;
  const { rerender } = render(workspace(baseSession));
  expect(screen.queryByRole('tablist', { name: 'Preview file' })).toBeNull();
  rerender(workspace({
    ...baseSession,
    preview: {
      id: '11111111-1111-4111-8111-111111111111',
      files: [
        { id: '40000000-4000-4000-8000-000000000001', fileName: 'a.html', kind: 'html' },
        { id: '40000000-4000-4000-8000-000000000002', fileName: 'notes.md', kind: 'markdown' },
      ],
    },
  }));
  const list = screen.getByRole('tablist', { name: 'Preview file' });
  const tabs = within(list).getAllByRole('tab');
  expect(tabs).toHaveLength(2);
  expect(tabs[0].getAttribute('aria-selected')).toBe('true');
  expect(tabs[1].getAttribute('aria-selected')).toBe('false');
});

it('replacing the set with all-new names selects the first file', () => {
  resizeTo(900);
  const sendCommand = vi.fn();
  const baseSession = { id: 'one', bridgeId: 'bridge', name: 'one', status: 'running', createdAt: '', updatedAt: '' } as Session;
  const workspace = (preview: Session['preview']) => <SessionWorkspace session={{ ...baseSession, preview }} client={null} userId="user" readable={false} sendCommand={sendCommand} securityGeneration={0} open onClose={vi.fn()} isDesktop mobileTab="preview" onMobileTab={vi.fn()} onRefit={vi.fn()}><div>Terminal</div></SessionWorkspace>;
  const { rerender } = render(workspace({
    id: '11111111-1111-4111-8111-111111111111',
    files: [
      { id: '40000000-4000-4000-8000-000000000001', fileName: 'a.html', kind: 'html' },
      { id: '40000000-4000-4000-8000-000000000002', fileName: 'b.html', kind: 'html' },
    ],
  }));
  let list = screen.getByRole('tablist', { name: 'Preview file' });
  let tabs = within(list).getAllByRole('tab');
  fireEvent.click(tabs[1]);
  expect(tabs[1].getAttribute('aria-selected')).toBe('true');
  rerender(workspace({
    id: '22222222-2222-4222-8222-222222222222',
    files: [
      { id: '40000000-4000-4000-8000-000000000011', fileName: 'x.html', kind: 'html' },
      { id: '40000000-4000-4000-8000-000000000012', fileName: 'y.md', kind: 'markdown' },
    ],
  }));
  list = screen.getByRole('tablist', { name: 'Preview file' });
  tabs = within(list).getAllByRole('tab');
  expect(tabs[0].getAttribute('aria-selected')).toBe('true');
  expect(tabs[1].getAttribute('aria-selected')).toBe('false');
});

it('add selects the newly added file and several new selects the last new', () => {
  resizeTo(900);
  const sendCommand = vi.fn();
  const baseSession = { id: 'one', bridgeId: 'bridge', name: 'one', status: 'running', createdAt: '', updatedAt: '' } as Session;
  const workspace = (preview: Session['preview']) => <SessionWorkspace session={{ ...baseSession, preview }} client={null} userId="user" readable={false} sendCommand={sendCommand} securityGeneration={0} open onClose={vi.fn()} isDesktop mobileTab="preview" onMobileTab={vi.fn()} onRefit={vi.fn()}><div>Terminal</div></SessionWorkspace>;
  const { rerender } = render(workspace({
    id: '11111111-1111-4111-8111-111111111111',
    files: [
      { id: '40000000-4000-4000-8000-000000000001', fileName: 'a.html', kind: 'html' },
    ],
  }));
  rerender(workspace({
    id: '22222222-2222-4222-8222-222222222222',
    files: [
      { id: '40000000-4000-4000-8000-000000000001', fileName: 'a.html', kind: 'html' },
      { id: '40000000-4000-4000-8000-000000000002', fileName: 'b.md', kind: 'markdown' },
    ],
  }));
  let list = screen.getByRole('tablist', { name: 'Preview file' });
  let tabs = within(list).getAllByRole('tab');
  expect(tabs[1].getAttribute('aria-selected')).toBe('true');
  expect(tabs[0].getAttribute('aria-selected')).toBe('false');
  rerender(workspace({
    id: '33333333-3333-4333-8333-333333333333',
    files: [
      { id: '40000000-4000-4000-8000-000000000001', fileName: 'a.html', kind: 'html' },
      { id: '40000000-4000-4000-8000-000000000002', fileName: 'b.md', kind: 'markdown' },
      { id: '40000000-4000-4000-8000-000000000003', fileName: 'c.html', kind: 'html' },
      { id: '40000000-4000-4000-8000-000000000004', fileName: 'd.html', kind: 'html' },
    ],
  }));
  list = screen.getByRole('tablist', { name: 'Preview file' });
  tabs = within(list).getAllByRole('tab');
  expect(tabs[3].getAttribute('aria-selected')).toBe('true');
  expect(tabs[0].getAttribute('aria-selected')).toBe('false');
  expect(tabs[1].getAttribute('aria-selected')).toBe('false');
});

it('dashboard reload with existing three-file set selects the first file', () => {
  resizeTo(900);
  const sendCommand = vi.fn();
  const session: Session = {
    id: 'one', bridgeId: 'bridge', name: 'one', status: 'running', createdAt: '', updatedAt: '',
    preview: {
      id: '12345678-1234-4234-8234-123456789abc',
      files: [
        { id: '40000000-4000-4000-8000-000000000001', fileName: 'a.html', kind: 'html' },
        { id: '40000000-4000-4000-8000-000000000002', fileName: 'b.html', kind: 'html' },
        { id: '40000000-4000-4000-8000-000000000003', fileName: 'c.html', kind: 'html' },
      ],
    },
  };
  render(<SessionWorkspace session={session} client={null} userId="user" readable={false} sendCommand={sendCommand} securityGeneration={0} open onClose={vi.fn()} isDesktop mobileTab="preview" onMobileTab={vi.fn()} onRefit={vi.fn()}><div>Terminal</div></SessionWorkspace>);
  const list = screen.getByRole('tablist', { name: 'Preview file' });
  const tabs = within(list).getAllByRole('tab');
  expect(tabs).toHaveLength(3);
  expect(tabs[0].getAttribute('aria-selected')).toBe('true');
  expect(tabs[1].getAttribute('aria-selected')).toBe('false');
  expect(tabs[2].getAttribute('aria-selected')).toBe('false');
});

it('mounts the switched iframe exactly once for unchanged bytes (P3)', async () => {
  vi.useFakeTimers();
  resizeTo(900);
  const originalSubtle = Object.getOwnPropertyDescriptor(globalThis.crypto, 'subtle');
  const htmlContent = '<p>first</p>'; const mdContent = '# Heading\n\n| A | B |\n|---|---|';
  const revisionHtml = 'a'.repeat(64); const revisionMd = 'b'.repeat(64);
  Object.defineProperty(globalThis.crypto, 'subtle', { configurable: true, value: { digest: async (_alg: string, bytes: Uint8Array) => {
    const text = new TextDecoder().decode(bytes);
    const byte = text === htmlContent ? 0xaa : 0xbb;
    return Uint8Array.from({ length: 32 }, () => byte).buffer;
  } } });
  try {
    const sendCommand = vi.fn((command: Command): Promise<CommandResponse> => {
      const payload = command.payload as Record<string, unknown>;
      const fileId = typeof payload.fileId === 'string' ? payload.fileId : '';
      const isHtml = fileId === '40000000-4000-4000-8000-000000000001';
      const text = isHtml ? htmlContent : mdContent;
      const rev = isHtml ? revisionHtml : revisionMd;
      if (command.type === 'session_preview_chunk') {
        return Promise.resolve({ requestId: 'c', success: true, data: { state: 'chunk', previewId: '12345678-1234-4234-8234-123456789abc', fileId, revision: rev, totalBytes: text.length, offset: 0, dataBase64: btoa(text), done: true } });
      }
      if ('knownRevision' in payload && payload.knownRevision === rev) {
        return Promise.resolve({ requestId: 's', success: true, data: { state: 'unchanged', previewId: '12345678-1234-4234-8234-123456789abc', fileId, revision: rev, totalBytes: text.length } });
      }
      return Promise.resolve({ requestId: 's', success: true, data: { state: 'ready', previewId: '12345678-1234-4234-8234-123456789abc', fileId, revision: rev, totalBytes: text.length } });
    });
    const session: Session = {
      id: 'one', bridgeId: 'bridge', name: 'one', status: 'running', createdAt: '', updatedAt: '',
      preview: {
        id: '12345678-1234-4234-8234-123456789abc',
        files: [
          { id: '40000000-4000-4000-8000-000000000001', fileName: 'a.html', kind: 'html' },
          { id: '40000000-4000-4000-8000-000000000002', fileName: 'notes.md', kind: 'markdown' },
        ],
      },
    };
    const { container } = render(<SessionWorkspace session={session} client={{} as unknown as MessageClient} userId="user" readable={true} sendCommand={sendCommand} securityGeneration={0} open onClose={vi.fn()} isDesktop mobileTab="preview" onMobileTab={vi.fn()} onRefit={vi.fn()}><div>Terminal</div></SessionWorkspace>);
    const added: HTMLIFrameElement[] = [];
    const observer = new MutationObserver(mutations => { for (const mutation of mutations) { mutation.addedNodes.forEach(node => { if (node instanceof HTMLIFrameElement) added.push(node); }); } });
    observer.observe(container, { childList: true, subtree: true });
    try {
      // Initial file A loads through the immediate first poll.
      await act(async () => {});
      const frameA = screen.getByTitle('Preview: a.html');
      expect(frameA).toBeTruthy();
      fireEvent.click(within(screen.getByRole('tablist', { name: 'Preview file' })).getByRole('tab', { name: 'notes.md' }));
      await act(async () => {});
      const frameB = screen.getByTitle('Preview: notes.md');
      expect(frameB).toBeTruthy();
      // Several 'unchanged' polls (1000ms cadence) until stable: the same DOM node must survive.
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      await act(async () => {});
      expect(screen.getByTitle('Preview: notes.md')).toBe(frameB);
      const notesFrames = new Set(added.filter(node => node.title === 'Preview: notes.md'));
      notesFrames.add(frameB as HTMLIFrameElement);
      expect(notesFrames.size).toBe(1);
      expect(added.filter(node => node.title === 'Preview: a.html')).toHaveLength(1);
    } finally { observer.disconnect(); }
  } finally {
    cleanup(); vi.useRealTimers();
    if (originalSubtle) Object.defineProperty(globalThis.crypto, 'subtle', originalSubtle); else Reflect.deleteProperty(globalThis.crypto, 'subtle');
  }
});

it.each([
  { reason: 'missing', expected: 'a.html is missing' },
  { reason: 'too_large', expected: 'a.html exceeds the 1 MiB limit' },
  { reason: 'invalid_utf8', expected: 'a.html is not valid UTF-8' },
  { reason: 'invalid_file', expected: 'a.html is unavailable' },
  { reason: 'unavailable', expected: 'a.html is unavailable' },
])('per-file error text includes the selected file name for reason $reason', async ({ reason, expected }) => {
  resizeTo(900);
  const previewId = '12345678-1234-4234-8234-123456789abc';
  const sendCommand = vi.fn((command: Command) => {
    const payload = command.payload as Record<string, unknown>;
    const fileId = typeof payload.fileId === 'string' ? payload.fileId : '40000000-4000-4000-8000-000000000001';
    const requestedPreviewId = typeof payload.previewId === 'string' ? payload.previewId : previewId;
    return Promise.resolve({ requestId: 'x', success: true, data: { state: 'unavailable', previewId: requestedPreviewId, fileId, reason } });
  });
  const session: Session = {
    id: 'one', bridgeId: 'bridge', name: 'one', status: 'running', createdAt: '', updatedAt: '',
    preview: {
      id: previewId,
      files: [
        { id: '40000000-4000-4000-8000-000000000001', fileName: 'a.html', kind: 'html' },
        { id: '40000000-4000-4000-8000-000000000002', fileName: 'notes.md', kind: 'markdown' },
      ],
    },
  };
  render(<SessionWorkspace session={session} client={{} as unknown as MessageClient} userId="user" readable={true} sendCommand={sendCommand} securityGeneration={0} open onClose={vi.fn()} isDesktop mobileTab="preview" onMobileTab={vi.fn()} onRefit={vi.fn()}><div>Terminal</div></SessionWorkspace>);
  await waitFor(() => expect(screen.getByRole('status').querySelector('span')?.textContent).toBe(expected));
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
});
