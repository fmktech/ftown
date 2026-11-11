// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
const ledger = { load: vi.fn(async () => {}), retryNow: vi.fn(async () => {}), discardPending: vi.fn(async () => 'discarded' as const), dismissDiscarded: vi.fn(async () => {}) };
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

describe('own removal not yet saved by the server', () => {
  const revoked = { ...ready, checkpoint: { ...checkpoint, devices: [], revokedDeviceIds: [endpoint.id] } };
  const unsavedSnap = (extra: Partial<LedgerClientSnapshot> = {}): LedgerClientSnapshot => ({ ...revoked, unsaved: { deviceIds: [endpoint.id], bridgeIds: [] }, serverState: 'behind', canReoffer: true, ...extra });
  const TEXT = "This browser's removal is not saved to the server yet. It can still connect. Retrying…";
  it('says it is still removing, offers Retry now and no Sign in again; nothing encrypted is mounted', async () => {
    mocks.useLedger.mockReturnValue({ client: ledger, snapshot: unsavedSnap() });
    render(<DashboardClient {...account} />);
    expect(await screen.findByRole('heading', { name: 'Removing this browser…' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(TEXT);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull();
    expect(mocks.runtime).not.toHaveBeenCalled(); expect(mocks.connection).not.toHaveBeenCalled(); expect(mocks.dashboard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    expect(ledger.retryNow).toHaveBeenCalledOnce();
  });
  it('disables Retry now with the seconds left while the server asked to wait', async () => {
    mocks.useLedger.mockReturnValue({ client: ledger, snapshot: unsavedSnap({ retryNotBefore: Date.now() + 42_000 }) });
    render(<DashboardClient {...account} />);
    const button = await screen.findByRole('button', { name: /Retry in \d+ s/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true); expect(button.textContent).toMatch(/^Retry in (41|42) s$/);
    fireEvent.click(button); expect(ledger.retryNow).not.toHaveBeenCalled();
  });
  it('becomes the removed screen with Sign in again, live, once the server has the removal', async () => {
    mocks.useLedger.mockReturnValue({ client: ledger, snapshot: unsavedSnap() });
    const { rerender } = render(<DashboardClient {...account} />);
    expect(await screen.findByRole('heading', { name: 'Removing this browser…' })).toBeTruthy();
    mocks.useLedger.mockReturnValue({ client: ledger, snapshot: { ...revoked, unsaved: { deviceIds: [], bridgeIds: [] }, serverState: 'current' } });
    rerender(<DashboardClient {...account} />);
    expect(await screen.findByRole('heading', { name: 'This browser was removed' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Sign in with your passkey to add it again.');
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
  });
  it('with nothing confirmed about the server says so and offers no Sign in again', async () => {
    mocks.useLedger.mockReturnValue({ client: ledger, snapshot: { ...revoked, serverState: 'unknown' } });
    const { rerender } = render(<DashboardClient {...account} />);
    expect(await screen.findByRole('heading', { name: 'This browser was removed' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Removed here. Not confirmed by the server yet.');
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull();
    mocks.useLedger.mockReturnValue({ client: ledger, snapshot: { ...revoked, serverState: 'current' } });
    rerender(<DashboardClient {...account} />);
    expect(await screen.findByRole('button', { name: 'Sign in again' })).toBeTruthy();
  });
  it('a pending removal of this browser is enforced here at once: no dashboard, "Removing this browser…", Retry now and Discard', async () => {
    // Not in the chain yet, but blocked here: the trusted checkpoint revokes this browser (snapshot.blocked), the status says so.
    const pending = { ...revoked, status: 'device_revoked' as const, pendingWrite: { operation: 'revoke_device' as const, deviceId: endpoint.id, since: 0 },
      unsaved: { deviceIds: [endpoint.id], bridgeIds: [] }, blocked: { deviceIds: [endpoint.id], bridgeIds: [] }, serverState: 'current' as const, canReoffer: true };
    mocks.useLedger.mockReturnValue({ client: ledger, snapshot: pending });
    render(<DashboardClient {...account} />);
    expect(await screen.findByRole('heading', { name: 'Removing this browser…' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(TEXT);
    expect(mocks.dashboard).not.toHaveBeenCalled(); expect(mocks.connection).not.toHaveBeenCalled();
    expect(screen.getByText('If the server already received it, it can still apply until another change is saved.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard this change' }));
    await waitFor(() => expect(ledger.discardPending).toHaveBeenCalledOnce());
    // The server lost the account: said so, and only Discard is offered.
    cleanup();
    mocks.useLedger.mockReturnValue({ client: ledger, snapshot: { ...pending, accountMissing: true } });
    render(<DashboardClient {...account} />);
    expect((await screen.findByText("Your account was not found on the server, so this browser's removal cannot be saved. You can discard it.")).getAttribute('role')).toBe('status');
    expect(screen.queryByRole('button', { name: 'Retry now' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Discard this change' })).toBeTruthy();
  });
  it("this browser's removal that was dropped or discarded is enforced here only: it says so and can keep this browser", async () => {
    const record = { payload: { type: 'ftown_account_transition', version: 2, accountId, revision: 2, previousHead: 'h'.repeat(43), issuedAt: 1, credentialId: 'c',
      operation: { type: 'revoke_device', endpointId: endpoint.id } }, signature: { authenticatorData: 'a', clientDataJSON: 'b', signature: 's' } } as unknown as LedgerClientSnapshot['discarded'][number];
    mocks.useLedger.mockReturnValue({ client: ledger, snapshot: { ...revoked, status: 'device_revoked', discarded: [record], blocked: { deviceIds: [endpoint.id], bridgeIds: [] },
      unsaved: { deviceIds: [], bridgeIds: [] }, serverState: 'current' } });
    render(<DashboardClient {...account} />);
    expect(await screen.findByRole('heading', { name: "This browser's removal was not saved" })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('It is applied on this browser only: your account and your computers still list this browser. Keep this browser to use it again.');
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Keep this browser' }));
    await waitFor(() => expect(ledger.dismissDiscarded).toHaveBeenCalledExactlyOnceWith([record]));
  });
  it('another browser unsaved removal does not change this browser removed screen', async () => {
    mocks.useLedger.mockReturnValue({ client: ledger, snapshot: { ...revoked, serverState: 'behind', unsaved: { deviceIds: ['other'], bridgeIds: [] } } });
    render(<DashboardClient {...account} />);
    expect(await screen.findByRole('button', { name: 'Sign in again' })).toBeTruthy();
  });
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
