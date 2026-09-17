import { afterEach, expect, it, vi } from 'vitest';
import { clearConnectionHistory, diagnosticEndpoint, getConnectionHistory, probeWebSocket, recordConnectionEvent } from './connection-history';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); clearConnectionHistory(); });

it('bounds history and strips credentials and query parameters from report endpoints', () => {
  for (let i = 0; i < 110; i++) recordConnectionEvent('attempt', { code: i });
  expect(getConnectionHistory()).toHaveLength(100);
  expect(getConnectionHistory()[0].details.code).toBe(10);
  expect(diagnosticEndpoint('wss://user:password@example.com/ws?token=secret#secret')).toBe('wss://example.com/ws');
});

it.each(['timeout', 'cancel', 'open', 'closed'])('closes diagnostic sockets on %s', async (outcome) => {
  vi.useFakeTimers();
  const socket = { onopen: null as null | (() => void), onclose: null as null | ((event: { code: number; wasClean: boolean }) => void), onerror: null, close: vi.fn() };
  vi.stubGlobal('WebSocket', class { constructor() { return socket; } });
  const controller = new AbortController();
  const result = probeWebSocket('wss://example.com/ws', controller.signal);
  if (outcome === 'timeout') await vi.advanceTimersByTimeAsync(5000);
  else if (outcome === 'cancel') controller.abort();
  else if (outcome === 'open') socket.onopen!();
  else socket.onclose!({ code: 1006, wasClean: false });
  expect((await result).result).toBe(outcome === 'cancel' ? 'cancelled' : outcome);
  expect(socket.close).toHaveBeenCalledTimes(1);
  expect(socket.onopen).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});
