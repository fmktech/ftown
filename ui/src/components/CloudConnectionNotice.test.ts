// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CloudConnectionNotice } from './CloudConnectionNotice';
import { clearConnectionHistory, getConnectionHistory, probeWebSocket } from '@/lib/connection-history';

vi.mock('@/lib/connection-history', async (original) => ({
  ...(await original<typeof import('@/lib/connection-history')>()),
  probeWebSocket: vi.fn().mockResolvedValue({ result: 'timeout', durationMs: 5000 }),
  probeWebsite: vi.fn().mockResolvedValue({ result: 'HTTP response', status: 200, durationMs: 80 }),
}));
const props = {
  connectionStatus: 'error' as const, connectionError: 'transport closed',
  centrifugoUrl: 'wss://example.com/connection/websocket?token=secret',
  token: 'private-token', onRetry: vi.fn(), directBridgeCount: 1,
};
beforeEach(() => { clearConnectionHistory(); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('shows the explanation only on interaction and retains history after recovery', async () => {
  const view = render(createElement(CloudConnectionNotice, props));
  expect(screen.queryByText(/Reachable Local/)).toBeNull();
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Connection status and diagnostics' }));
  expect(screen.getByText(/Reachable Local/)).toBeTruthy();
  expect(screen.getByText(/Endpoint:/).textContent).not.toContain('secret');
  expect(getConnectionHistory().some((e) => e.event === 'WebSocket probe')).toBe(true);
  view.rerender(createElement(CloudConnectionNotice, { ...props, connectionStatus: 'connected' }));
  expect(screen.getByText(/Recent outage history/)).toBeTruthy();
  expect(getConnectionHistory().some((e) => e.event === 'cloud recovered')).toBe(true);
  expect(JSON.stringify(getConnectionHistory())).not.toMatch(/secret|private-token/);
  fireEvent.keyDown(screen.getByRole('button', { name: 'Connection status and diagnostics' }), { key: 'Escape' });
  expect(screen.queryByRole('region')).toBeNull();
  expect(props.onRetry).not.toHaveBeenCalled();
});

it('throttles automatic outage checks and records browser connectivity changes', async () => {
  vi.useFakeTimers();
  const view = render(createElement(CloudConnectionNotice, props));
  await act(async () => {});
  expect(probeWebSocket).toHaveBeenCalledTimes(1);
  view.rerender(createElement(CloudConnectionNotice, { ...props, connectionStatus: 'connecting' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(29_000); });
  expect(probeWebSocket).toHaveBeenCalledTimes(1);
  fireEvent(window, new Event('offline'));
  expect(getConnectionHistory().at(-1)?.event).toBe('browser offline');
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(probeWebSocket).toHaveBeenCalledTimes(2);
  view.rerender(createElement(CloudConnectionNotice, { ...props, connectionStatus: 'connected' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(probeWebSocket).toHaveBeenCalledTimes(2);
});
