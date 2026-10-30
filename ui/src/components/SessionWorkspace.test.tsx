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
  const workspace = (readable: boolean) => <SessionWorkspace session={session} client={client} userId="user" readable={readable} sendCommand={sendCommand} subscribeAuthority={subscribeAuthority} securityGeneration={0} open onClose={vi.fn()} isDesktop mobileTab="preview" onMobileTab={vi.fn()} onRefit={vi.fn()}><div data-testid="terminal-node">Terminal content</div></SessionWorkspace>;
  const { container, rerender } = render(workspace(true));
  const frame = await screen.findByTitle('HTML preview: demo.html');
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-popups allow-popups-to-escape-sandbox');
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
