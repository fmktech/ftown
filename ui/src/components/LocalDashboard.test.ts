// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LocalDashboard } from './LocalDashboard';
import { readDevice, rememberDevice } from '@/lib/local-browser-client';

vi.mock('./Dashboard', () => ({ Dashboard: (props: { localMode: boolean; onDisconnect: () => void }) =>
  React.createElement('div', null, 'Local dashboard ' + String(props.localMode), React.createElement('button', { onClick: props.onDisconnect }, 'Forget')) }));
vi.mock('@/lib/direct-transport/hybrid-terminal-transport', () => ({
  HybridTerminalTransport: class { dispose() {} },
}));
const credential = 'local-secret';
const boot = { version: 1, userId: 'local', bridgeId: 'bridge', hostname: 'laptop', localPort: 40124, localNonce: credential };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, '', '/local?port=40123'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows matching approval code then opens the shared dashboard with session-only credentials', async () => {
  let approved = false;
  const fetcher = vi.fn().mockImplementation((url: string) => {
    if (url.endsWith('/pairings')) return Promise.resolve(json({ id: 'pair', code: '482193', pollToken: 'poll', expiresAt: new Date(Date.now() + 120000).toISOString() }));
    if (url.endsWith('/pairings/pair')) return Promise.resolve(json(approved ? { status: 'approved', credential } : { status: 'pending' }));
    if (url.endsWith('/bootstrap')) return Promise.resolve(json(boot));
    return new Promise(() => {});
  });
  vi.stubGlobal('fetch', fetcher);
  render(React.createElement(LocalDashboard));
  fireEvent.click(screen.getByLabelText('Remember this browser'));
  fireEvent.click(screen.getByRole('button', { name: 'Connect locally' }));
  await screen.findByText('482193');
  expect(screen.queryByText('Local dashboard true')).toBeNull();
  approved = true;
  await screen.findByText('Local dashboard true', {}, { timeout: 3000 });
  expect(localStorage.getItem('ftown:local:device:40123')).toBeNull();
  expect(readDevice()).toEqual({ port: 40123, bridgeId: 'bridge', credential });
  expect(fetcher.mock.calls.every(([url]) => String(url).startsWith('http://127.0.0.1:40123/api/browser/'))).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
  expect(readDevice()).toBeNull();
});

it('restores remembered approval without any login or pairing call', async () => {
  rememberDevice({ port: 40123, bridgeId: 'bridge', credential }, true);
  const fetcher = vi.fn().mockImplementation((url: string) => url.endsWith('/bootstrap')
    ? Promise.resolve(json(boot)) : new Promise(() => {}));
  vi.stubGlobal('fetch', fetcher);
  render(React.createElement(LocalDashboard));
  await screen.findByText('Local dashboard true');
  expect(fetcher.mock.calls.every(([url]) => String(url).startsWith('http://127.0.0.1:40123/api/browser/'))).toBe(true);
  expect(fetcher.mock.calls.some(([url]) => String(url).includes('pairing'))).toBe(false);
});

it('forgets rejected saved credentials', async () => {
  rememberDevice({ port: 40123, bridgeId: 'bridge', credential }, true);
  const fetcher = vi.fn().mockResolvedValue(json({ error: 'revoked' }, 401));
  vi.stubGlobal('fetch', fetcher);
  render(React.createElement(LocalDashboard));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('revoked'));
  expect(readDevice()).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:40123/api/browser/bootstrap');
});

it('keeps remembered credentials on a temporary connection failure so retry does not require approval', async () => {
  rememberDevice({ port: 40123, bridgeId: 'bridge', credential }, true);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Bridge unreachable')));
  render(React.createElement(LocalDashboard));
  await screen.findByText('Bridge unreachable');
  expect(readDevice()?.bridgeId).toBe('bridge');
});
