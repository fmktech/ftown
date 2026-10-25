// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BrowserIdentityState } from '@/hooks/useBrowserIdentity';
import type { AccountSecurityClient, AccountSecuritySnapshot } from '@/lib/account-security-client';
import type { EndpointIdentity } from '@security/protocol';
const mocks = vi.hoisted(() => ({ identity: vi.fn(), signOut: vi.fn(), detach: vi.fn(), connection: vi.fn(), runtime: vi.fn(), dashboard: vi.fn(), push: vi.fn(), approval: vi.fn() }));
vi.mock('@/hooks/useBrowserIdentity', () => ({ useBrowserIdentity: mocks.identity }));
vi.mock('@/lib/auth-mode', () => ({ useAuthMode: () => ({ signOut: mocks.signOut }) }));
vi.mock('@/hooks/useCentrifugo', () => ({ useCentrifugo: mocks.connection }));
vi.mock('@/lib/secure-endpoint-runtime', () => ({ SecureEndpointRuntime: class { constructor(...args: unknown[]) { mocks.runtime(...args); } replacePins() {} dispose() {} } }));
vi.mock('./Dashboard', () => ({ Dashboard: (props: unknown) => { mocks.dashboard(props); return <section aria-label="Encrypted dashboard" />; } }));
vi.mock('./DeviceApproval', () => ({ DeviceApproval: (props: unknown) => { mocks.approval(props); return <section aria-label="Waiting for device approval" />; } }));
vi.mock('./PushNotificationsControl', () => ({ detachPushSubscription: mocks.detach,
  PushNotificationsControl: (props: unknown) => { mocks.push(props); return <button>Enable push notifications</button>; } }));
vi.mock('./SecurityPanel', () => ({ securityErrorMessage: () => 'Encrypted access is unavailable' }));
import { DashboardClient } from './DashboardClient';
const ownerId = '349f8d2e-38e4-4d59-888d-687dcfa19e39';
const email = 'owner@ftown.test';
const identity = { endpoint: { id: 'browser', ownerId, kind: 'browser', version: 1, publicKey: 'public' }, keyPair: {} } as EndpointIdentity;
const accountClient = { assertBridgeAccess: vi.fn() } as unknown as AccountSecurityClient;
function state(status: 'unapproved' | 'ready'): BrowserIdentityState {
  const account: AccountSecuritySnapshot = { status, identity, signing: null, trust: null, legacyBridges: [], historyExists: status === 'ready', code: null, offline: false };
  return { status: 'ready', identity, bridges: [], code: null, accountClient, account };
}
const props = { ownerId, userId: email, token: 'test-token', centrifugoUrl: 'wss://relay.test' };
beforeEach(() => {
  vi.clearAllMocks(); mocks.identity.mockReturnValue(state('unapproved')); mocks.detach.mockResolvedValue(undefined);
  mocks.connection.mockReturnValue({ client: null, status: 'connecting', error: null, transport: null });
});
afterEach(cleanup);
it('pending browsers retain account menu and existing push control without constructing encrypted resources', () => {
  render(<DashboardClient {...props} />);
  expect(screen.getByRole('region', { name: 'Waiting for device approval' })).toBeTruthy();
  expect(screen.getByTitle(email)).toBeTruthy(); expect(screen.getByRole('button', { name: 'Enable push notifications' })).toBeTruthy();
  expect(mocks.push.mock.calls[0][0]).toEqual({ accountId: email });
  expect(mocks.approval.mock.calls[0][0]).toEqual({ ownerId, email, client: accountClient });
  expect(mocks.runtime).not.toHaveBeenCalled(); expect(mocks.connection).not.toHaveBeenCalled(); expect(mocks.dashboard).not.toHaveBeenCalled();
});
it('Disconnect waits for push cleanup before normal sign-out, without granting session authority', async () => {
  let finish: () => void = () => {};
  mocks.detach.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  render(<DashboardClient {...props} />); fireEvent.click(screen.getByTitle(email));
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
  expect(mocks.detach).toHaveBeenCalledOnce(); expect(mocks.signOut).not.toHaveBeenCalled();
  await act(async () => { finish(); }); await waitFor(() => expect(mocks.signOut).toHaveBeenCalledOnce());
  expect(mocks.runtime).not.toHaveBeenCalled(); expect(mocks.connection).not.toHaveBeenCalled();
});
it('failed push cleanup cannot trap an unapproved browser in a signed-in session', async () => {
  mocks.detach.mockRejectedValueOnce(new Error('cleanup unavailable'));
  render(<DashboardClient {...props} />); fireEvent.click(screen.getByTitle(email)); fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
  await waitFor(() => expect(mocks.signOut).toHaveBeenCalledOnce());
  expect(screen.queryByText('cleanup unavailable')).toBeNull(); expect(mocks.runtime).not.toHaveBeenCalled();
});
it('the admitted branch still creates the existing encrypted runtime and renders Dashboard', () => {
  mocks.identity.mockReturnValue(state('ready')); render(<DashboardClient {...props} />);
  expect(screen.getByRole('region', { name: 'Encrypted dashboard' })).toBeTruthy(); expect(mocks.runtime).toHaveBeenCalledWith(identity, [], accountClient.assertBridgeAccess);
  expect(mocks.connection).toHaveBeenCalledWith(props.token, props.centrifugoUrl, email, expect.objectContaining({ securityRuntime: expect.any(Object) }));
  expect(mocks.dashboard.mock.calls[0][0]).toEqual(expect.objectContaining({ userId: email, accountClient, accountState: expect.objectContaining({ status: 'ready' }) }));
  expect(mocks.push).not.toHaveBeenCalled(); expect(mocks.approval).not.toHaveBeenCalled();
});
