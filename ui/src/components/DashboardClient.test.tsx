// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LedgerCheckpoint } from '@security/ledger/protocol';
import type { ApprovedBridge, EndpointIdentity } from '@security/protocol';
import type { LedgerClientSnapshot } from '@/lib/ledger-client';
const mocks = vi.hoisted(() => ({ loadIdentity: vi.fn(), readPins: vi.fn(), useLedger: vi.fn(), signOut: vi.fn(), detach: vi.fn(), connection: vi.fn(),
  runtime: vi.fn(), replacePins: vi.fn(), dashboard: vi.fn() }));
vi.mock('@/lib/browser-identity', () => ({ loadBrowserIdentity: mocks.loadIdentity, readPinnedBridges: mocks.readPins }));
vi.mock('@/hooks/useLedger', () => ({ useLedger: mocks.useLedger }));
vi.mock('@/lib/auth-mode', () => ({ useAuthMode: () => ({ signOut: mocks.signOut }) }));
vi.mock('@/hooks/useCentrifugo', () => ({ useCentrifugo: mocks.connection }));
vi.mock('@/lib/secure-endpoint-runtime', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/secure-endpoint-runtime')>(),
  SecureEndpointRuntime: class { constructor(...args: unknown[]) { mocks.runtime(...args); } replacePins(pins: unknown) { mocks.replacePins(pins); } dispose() {} },
}));
vi.mock('./Dashboard', () => ({ Dashboard: (props: unknown) => { mocks.dashboard(props); return <section aria-label="Encrypted dashboard" />; } }));
vi.mock('./PushNotificationsControl', () => ({ detachPushSubscription: mocks.detach }));
vi.mock('./SecurityPanel', () => ({ securityErrorMessage: () => 'Encrypted access is unavailable' }));
import { DashboardClient } from './DashboardClient';

const accountId = 'A'.repeat(43);
const endpoint = { id: 'browser-endpoint', ownerId: accountId, kind: 'browser' as const, version: 1 as const, publicKey: 'browser-public' };
const identity = { endpoint, keyPair: {} } as unknown as EndpointIdentity;
const checkpoint: LedgerCheckpoint = { version: 2, accountId, revision: 1, head: 'h'.repeat(43), authorities: [],
  devices: [{ endpoint, authPublicKey: 'device-key', label: 'Laptop', approvedAt: 0 }], bridges: [], revokedDeviceIds: [], revokedBridgeIds: [] };
const ledger = { load: vi.fn(async () => {}) };
const signedOut: LedgerClientSnapshot = { status: 'signed_out', checkpoint: null, discarded: [], localOnly: { deviceIds: [], bridgeIds: [] }, signer: null, pending: 'none' };
const ready: LedgerClientSnapshot = { ...signedOut, status: 'ready', checkpoint };
const account = { ownerId: accountId, userId: accountId, token: 'test-token', centrifugoUrl: 'wss://relay.test' };
const soloOwner = 'solo:bridge-one';
const soloIdentity = { endpoint: { ...endpoint, ownerId: soloOwner }, keyPair: {} } as unknown as EndpointIdentity;
const soloPins: ApprovedBridge[] = [{ bridgeId: 'bridge-one', endpoint: { id: 'bridge-endpoint', ownerId: soloOwner, kind: 'bridge', version: 1, publicKey: 'bridge-public' }, permissions: ['read', 'control', 'admin'] }];
const solo = { ownerId: soloOwner, userId: 'solo', token: 'solo-token', centrifugoUrl: 'ws://lan.test', tokenRefresher: vi.fn(), onUnauthorized: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadIdentity.mockImplementation(async (owner: string) => owner === soloOwner ? soloIdentity : identity);
  mocks.readPins.mockResolvedValue(soloPins);
  mocks.useLedger.mockReturnValue({ client: ledger, snapshot: ready });
  mocks.detach.mockResolvedValue(undefined);
  mocks.connection.mockReturnValue({ client: null, status: 'connecting', error: null, transport: null });
});
afterEach(cleanup);

it('account mode: the ledger client is the only bridge authority and feeds the relay ledger channel', async () => {
  render(<DashboardClient {...account} />);
  expect(await screen.findByRole('region', { name: 'Encrypted dashboard' })).toBeTruthy();
  expect(mocks.loadIdentity).toHaveBeenCalledWith(accountId); expect(mocks.readPins).not.toHaveBeenCalled();
  expect(mocks.runtime).toHaveBeenCalledWith(identity, { ledger }); expect(mocks.replacePins).not.toHaveBeenCalled();
  expect(mocks.connection).toHaveBeenCalledWith(account.token, account.centrifugoUrl, accountId, expect.objectContaining({ securityRuntime: expect.any(Object), ledger }));
  expect(mocks.dashboard.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ userId: accountId, accountId }));
  expect(mocks.dashboard.mock.calls.at(-1)?.[0]).not.toHaveProperty('accountClient');
});

it('Solo keeps invitation pins and never touches the ledger', async () => {
  render(<DashboardClient {...solo} />);
  expect(await screen.findByRole('region', { name: 'Encrypted dashboard' })).toBeTruthy();
  expect(mocks.useLedger).not.toHaveBeenCalled(); expect(ledger.load).not.toHaveBeenCalled();
  expect(mocks.readPins).toHaveBeenCalledWith(soloOwner);
  expect(mocks.runtime).toHaveBeenCalledWith(soloIdentity, soloPins); expect(mocks.replacePins).toHaveBeenCalledWith(soloPins);
  const options = mocks.connection.mock.calls.at(-1)?.[3] as Record<string, unknown>;
  expect(options).toMatchObject({ tokenRefresher: solo.tokenRefresher, onUnauthorized: solo.onUnauthorized }); expect(options.ledger).toBeUndefined();
  expect(mocks.dashboard.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ userId: 'solo', accountId: null }));
});

it('a browser removed from the ledger gets no encrypted resources, and Sign in again detaches push before signing out', async () => {
  mocks.useLedger.mockReturnValue({ client: ledger, snapshot: { ...ready, checkpoint: { ...checkpoint, devices: [], revokedDeviceIds: [endpoint.id] } } });
  let finish: () => void = () => {};
  mocks.detach.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  render(<DashboardClient {...account} />);
  expect(await screen.findByRole('heading', { name: 'This browser was removed' })).toBeTruthy();
  expect(mocks.runtime).not.toHaveBeenCalled(); expect(mocks.connection).not.toHaveBeenCalled(); expect(mocks.dashboard).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
  expect(mocks.detach).toHaveBeenCalledOnce(); expect(mocks.signOut).not.toHaveBeenCalled();
  await act(async () => { finish(); }); await waitFor(() => expect(mocks.signOut).toHaveBeenCalledOnce());
});

it('a removal while the dashboard is open unmounts the encrypted dashboard', async () => {
  const { rerender } = render(<DashboardClient {...account} />);
  expect(await screen.findByRole('region', { name: 'Encrypted dashboard' })).toBeTruthy();
  mocks.useLedger.mockReturnValue({ client: ledger, snapshot: { ...ready, status: 'device_revoked' } });
  rerender(<DashboardClient {...account} />);
  expect(await screen.findByRole('heading', { name: 'This browser was removed' })).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Encrypted dashboard' })).toBeNull();
});

it('a browser that is not a device of the account (unbound replica) is asked to sign in again', async () => {
  mocks.useLedger.mockReturnValue({ client: ledger, snapshot: signedOut });
  render(<DashboardClient {...account} />);
  expect(await screen.findByRole('heading', { name: 'Sign in again' })).toBeTruthy();
  expect(mocks.runtime).not.toHaveBeenCalled(); expect(mocks.connection).not.toHaveBeenCalled();
  mocks.signOut.mockClear(); fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
  await waitFor(() => expect(mocks.signOut).toHaveBeenCalledOnce());
});

it('an unusable ledger store or insecure context fails closed with the existing notice', async () => {
  mocks.useLedger.mockReturnValue({ client: ledger, snapshot: { ...signedOut, status: 'error', error: 'secure_context_required' } });
  render(<DashboardClient {...account} />);
  expect(await screen.findByText(/Open FTown over HTTPS/)).toBeTruthy();
  expect(mocks.runtime).not.toHaveBeenCalled(); expect(mocks.connection).not.toHaveBeenCalled();
});
