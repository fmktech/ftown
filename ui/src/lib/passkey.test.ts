import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { accountIdOf, authorityConsentChallenge, ledgerChallenge, nextTransition, signInChallenge, verifyLedger } from '@security/ledger/ledger';
import type { EndpointPublic } from '@security/protocol';
import type { Ledger, LedgerGenesis } from '@security/ledger/protocol';
import { verifyPasskeyAssertion } from '@security/ledger/webauthn';
import { createSoftPasskey } from '@security/ledger/testing';
import type { SoftPasskey } from '@security/ledger/testing';
import { createPasskey, identifyPasskey, passkeySupported, signAuthorityConsent, signLedgerRecord } from './passkey';

const rpId = 'ftown.example';
const origin = 'https://ftown.example';
const b64 = (data: Uint8Array): string => Buffer.from(data).toString('base64url');
const unb64 = (value: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(value, 'base64url'));
const buf = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;
const SPKI_PREFIX = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
]);
const spkiOf = (raw: Uint8Array): Uint8Array => Uint8Array.from([...SPKI_PREFIX, ...raw]);

interface FakeAuthenticator {
  passkey: SoftPasskey;
  create: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  userHandle: Uint8Array | null;
  spki: Uint8Array | null;
  alg: number;
}
async function fakeAuthenticator(): Promise<FakeAuthenticator> {
  const passkey = await createSoftPasskey({ rpId, origin });
  const fake = {
    passkey, userHandle: crypto.getRandomValues(new Uint8Array(32)), spki: spkiOf(unb64(passkey.publicKey)) as Uint8Array | null, alg: -7,
  } as FakeAuthenticator;
  fake.create = vi.fn(async () => ({
    rawId: buf(unb64(passkey.credentialId)),
    response: {
      getPublicKey: () => (fake.spki === null ? null : buf(fake.spki)),
      getPublicKeyAlgorithm: () => fake.alg,
    },
  }));
  fake.get = vi.fn(async (request: CredentialRequestOptions) => {
    const challenge = new Uint8Array(request.publicKey!.challenge as ArrayBuffer);
    const signature = await passkey.sign(challenge);
    return {
      rawId: buf(unb64(passkey.credentialId)),
      response: {
        authenticatorData: buf(unb64(signature.authenticatorData)),
        clientDataJSON: buf(unb64(signature.clientDataJSON)),
        signature: buf(unb64(signature.signature)),
        userHandle: fake.userHandle === null ? null : buf(fake.userHandle),
      },
    };
  });
  vi.stubGlobal('navigator', { credentials: { create: fake.create, get: fake.get } });
  return fake;
}
const sha256 = (data: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(data).digest());
async function deviceEndpoint(ownerId: string): Promise<{ endpoint: EndpointPublic; authPublicKey: string }> {
  const ecdh = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', ecdh.publicKey));
  const ecdsa = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const auth = new Uint8Array(await crypto.subtle.exportKey('raw', ecdsa.publicKey));
  return { endpoint: { version: 1, id: b64(sha256(raw)), ownerId, kind: 'browser', publicKey: b64(raw) }, authPublicKey: b64(auth) };
}

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('PublicKeyCredential', class {});
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('passkeySupported', () => {
  it('needs a secure context, PublicKeyCredential and navigator.credentials', async () => {
    await fakeAuthenticator();
    expect(passkeySupported()).toBe(true);
    vi.stubGlobal('isSecureContext', false);
    expect(passkeySupported()).toBe(false);
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('PublicKeyCredential', undefined);
    expect(passkeySupported()).toBe(false);
  });
});

describe('createPasskey', () => {
  it('requests exactly ES256, a required resident key and required user verification', async () => {
    const fake = await fakeAuthenticator();
    const handle = crypto.getRandomValues(new Uint8Array(32));
    const excluded = b64(crypto.getRandomValues(new Uint8Array(32)));
    const authority = await createPasskey({ rpId, rpName: 'ftown', handle, userName: 'me@example.com', excludeCredentialIds: [excluded] });
    expect(fake.create).toHaveBeenCalledTimes(1);
    const publicKey = fake.create.mock.calls[0][0].publicKey as PublicKeyCredentialCreationOptions;
    expect(publicKey.pubKeyCredParams).toEqual([{ type: 'public-key', alg: -7 }]);
    expect(publicKey.authenticatorSelection).toEqual({ residentKey: 'required', requireResidentKey: true, userVerification: 'required' });
    expect(publicKey.rp).toEqual({ id: rpId, name: 'ftown' });
    expect(Array.from(publicKey.user.id as Uint8Array)).toEqual(Array.from(handle));
    expect(publicKey.user.name).toBe('me@example.com');
    expect((publicKey.challenge as Uint8Array).length).toBeGreaterThanOrEqual(32);
    expect(authority.credentialId).toBe(fake.passkey.credentialId);
    expect(authority).toEqual({ credentialId: fake.passkey.credentialId, publicKey: fake.passkey.publicKey });
    expect(publicKey.excludeCredentials).toHaveLength(1);
    expect(b64(new Uint8Array(publicKey.excludeCredentials![0].id as ArrayBuffer))).toBe(excluded);
  });

  it('extracts the raw 65-byte point from the SPKI key', async () => {
    const fake = await fakeAuthenticator();
    const authority = await createPasskey({ rpId, rpName: 'ftown', handle: new Uint8Array(32), userName: 'u' });
    expect(authority.publicKey).toBe(fake.passkey.publicKey);
    expect(unb64(authority.publicKey)).toHaveLength(65);
    expect(unb64(authority.publicKey)[0]).toBe(4);
  });

  it('rejects a P-384 key, a wrong algorithm, a missing key and an off-curve point', async () => {
    const fake = await fakeAuthenticator();
    const input = { rpId, rpName: 'ftown', handle: new Uint8Array(32), userName: 'u' };
    const p384 = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign', 'verify']);
    fake.spki = new Uint8Array(await crypto.subtle.exportKey('spki', p384.publicKey));
    await expect(createPasskey(input)).rejects.toThrow('passkey_not_p256');
    fake.spki = spkiOf(unb64(fake.passkey.publicKey));
    fake.alg = -257;
    await expect(createPasskey(input)).rejects.toThrow('passkey_not_p256');
    fake.alg = -7;
    fake.spki = spkiOf(Uint8Array.from([4, ...crypto.getRandomValues(new Uint8Array(64))]));
    await expect(createPasskey(input)).rejects.toThrow('passkey_not_p256');
    fake.spki = null;
    await expect(createPasskey(input)).rejects.toThrow('passkey_key_unavailable');
  });

  it('maps NotAllowedError to passkey_cancelled and rethrows other errors', async () => {
    const fake = await fakeAuthenticator();
    const input = { rpId, rpName: 'ftown', handle: new Uint8Array(32), userName: 'u' };
    fake.create.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    await expect(createPasskey(input)).rejects.toThrow('passkey_cancelled');
    fake.create.mockRejectedValueOnce(Object.assign(new Error('dup'), { name: 'InvalidStateError' }));
    await expect(createPasskey(input)).rejects.toThrow('passkey_already_registered');
    fake.create.mockRejectedValueOnce(Object.assign(new Error('boom'), { name: 'SecurityError' }));
    await expect(createPasskey(input)).rejects.toThrow('boom');
  });
});

describe('secure context and framing', () => {
  it('throws secure_context_required without a secure context or crypto.subtle', async () => {
    const fake = await fakeAuthenticator();
    vi.stubGlobal('isSecureContext', false);
    await expect(identifyPasskey({ rpId })).rejects.toThrow('secure_context_required');
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    await expect(identifyPasskey({ rpId })).rejects.toThrow('secure_context_required');
    expect(fake.get).not.toHaveBeenCalled();
  });

  it('refuses to run inside a frame', async () => {
    const fake = await fakeAuthenticator();
    vi.stubGlobal('window', { self: {}, top: {} });
    await expect(identifyPasskey({ rpId })).rejects.toThrow('passkey_embedded');
    expect(fake.get).not.toHaveBeenCalled();
  });
});

describe('signLedgerRecord', () => {
  async function genesisFor(fake: FakeAuthenticator): Promise<LedgerGenesis> {
    const handle = crypto.getRandomValues(new Uint8Array(32));
    const created = await createPasskey({ rpId, rpName: 'ftown', handle, userName: 'u' });
    const now = Date.now();
    return {
      type: 'ftown_account_genesis', version: 2, rpId, origins: [origin], handle: b64(handle), createdAt: now,
      authority: { ...created, label: 'iCloud Keychain', addedAt: now },
    };
  }

  it('signs over ledgerChallenge(payload) with required UV and the credential allow-list', async () => {
    const fake = await fakeAuthenticator();
    const genesis = await genesisFor(fake);
    const signed = await signLedgerRecord(genesis, { rpId });
    const request = fake.get.mock.calls[0][0].publicKey as PublicKeyCredentialRequestOptions;
    expect(request.userVerification).toBe('required');
    expect(request.rpId).toBe(rpId);
    expect(Array.from(new Uint8Array(request.challenge as ArrayBuffer))).toEqual(Array.from(await ledgerChallenge(genesis)));
    expect(request.allowCredentials).toHaveLength(1);
    expect(b64(new Uint8Array(request.allowCredentials![0].id as ArrayBuffer))).toBe(fake.passkey.credentialId);
    expect(signed.payload).toBe(genesis);
  });

  it('produces signatures that verifyLedger accepts in a real chain', async () => {
    const fake = await fakeAuthenticator();
    const genesis = await genesisFor(fake);
    let ledger: Ledger = { genesis: await signLedgerRecord(genesis, { rpId }), transitions: [] };
    const accountId = await accountIdOf(genesis);
    const { endpoint, authPublicKey } = await deviceEndpoint(accountId);
    const checkpoint = await verifyLedger(ledger);
    const payload = nextTransition(checkpoint, fake.passkey.credentialId, {
      type: 'add_device', device: { endpoint, authPublicKey, label: 'MacBook', approvedAt: Date.now() },
    }, Date.now(), genesis.createdAt);
    ledger = { genesis: ledger.genesis, transitions: [await signLedgerRecord(payload, { rpId })] };
    const verified = await verifyLedger(ledger);
    expect(verified.revision).toBe(1);
    expect(verified.devices.map(device => device.endpoint.id)).toEqual([endpoint.id]);
  });

  it('a signature over a different payload does not verify', async () => {
    const fake = await fakeAuthenticator();
    const genesis = await genesisFor(fake);
    const signed = await signLedgerRecord(genesis, { rpId });
    const tampered = { ...signed, payload: { ...genesis, createdAt: genesis.createdAt + 1 } };
    await expect(verifyLedger({ genesis: tampered, transitions: [] })).rejects.toThrow();
  });

  it('rejects an assertion from an unexpected credential', async () => {
    const fake = await fakeAuthenticator();
    const genesis = await genesisFor(fake);
    const other = await createSoftPasskey({ rpId, origin });
    await expect(signLedgerRecord(genesis, { rpId, credentialId: other.credentialId })).rejects.toThrow('passkey_wrong_credential');
    expect(fake.get).not.toHaveBeenCalled();
  });

  it('passes allowCredentialIds and rpId on every get', async () => {
    const fake = await fakeAuthenticator();
    const genesis = await genesisFor(fake);
    const ids = [fake.passkey.credentialId, b64(crypto.getRandomValues(new Uint8Array(32)))];
    await signLedgerRecord(genesis, { rpId, allowCredentialIds: ids });
    const request = fake.get.mock.calls[0][0].publicKey as PublicKeyCredentialRequestOptions;
    expect(request.rpId).toBe(rpId);
    expect(request.allowCredentials!.map(c => b64(new Uint8Array(c.id as ArrayBuffer)))).toEqual(ids);
  });

  it('maps cancellation', async () => {
    const fake = await fakeAuthenticator();
    const genesis = await genesisFor(fake);
    fake.get.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'NotAllowedError' }));
    await expect(signLedgerRecord(genesis, { rpId })).rejects.toThrow('passkey_cancelled');
  });
});

describe('identifyPasskey', () => {
  it('returns the userHandle and credential id from a discoverable assertion over a sign-in challenge', async () => {
    const fake = await fakeAuthenticator();
    const result = await identifyPasskey({ rpId });
    expect(result).toEqual({ credentialId: fake.passkey.credentialId, handle: b64(fake.userHandle!) });
    const request = fake.get.mock.calls[0][0].publicKey as PublicKeyCredentialRequestOptions;
    expect(request.userVerification).toBe('required');
    expect(request.allowCredentials).toBeUndefined();
    const challenge = new Uint8Array(request.challenge as ArrayBuffer);
    expect(challenge).toHaveLength(32);
    // The challenge is in the sign-in domain, not the ledger domain: it is the hash of some fresh nonce.
    expect(challenge).not.toEqual(await signInChallenge('A'.repeat(43)));
  });

  it('passes rpId and allowCredentialIds', async () => {
    const fake = await fakeAuthenticator();
    const id = b64(crypto.getRandomValues(new Uint8Array(32)));
    await identifyPasskey({ rpId, allowCredentialIds: [id] });
    const request = fake.get.mock.calls[0][0].publicKey as PublicKeyCredentialRequestOptions;
    expect(request.rpId).toBe(rpId);
    expect(request.allowCredentials!.map(c => b64(new Uint8Array(c.id as ArrayBuffer)))).toEqual([id]);
  });

  it('uses a fresh nonce each time', async () => {
    const fake = await fakeAuthenticator();
    await identifyPasskey({ rpId });
    await identifyPasskey({ rpId });
    const first = Buffer.from(fake.get.mock.calls[0][0].publicKey.challenge).toString('hex');
    const second = Buffer.from(fake.get.mock.calls[1][0].publicKey.challenge).toString('hex');
    expect(first).not.toBe(second);
  });

  it('fails without a userHandle and maps cancellation', async () => {
    const fake = await fakeAuthenticator();
    fake.userHandle = null;
    await expect(identifyPasskey({ rpId })).rejects.toThrow('passkey_no_handle');
    fake.get.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'NotAllowedError' }));
    await expect(identifyPasskey({ rpId })).rejects.toThrow('passkey_cancelled');
  });
});

describe('signAuthorityConsent', () => {
  const accountId = b64(crypto.getRandomValues(new Uint8Array(32)));

  it('asks exactly the named credential, with UV and rpId, over the consent challenge, and the signature verifies', async () => {
    const fake = await fakeAuthenticator();
    const authority = { credentialId: fake.passkey.credentialId, publicKey: fake.passkey.publicKey };
    const consent = await signAuthorityConsent({ accountId, authority, rpId });
    const request = fake.get.mock.calls[0][0].publicKey as PublicKeyCredentialRequestOptions;
    expect(request.userVerification).toBe('required');
    expect(request.rpId).toBe(rpId);
    expect(request.allowCredentials).toHaveLength(1);
    expect(b64(new Uint8Array(request.allowCredentials![0].id as ArrayBuffer))).toBe(fake.passkey.credentialId);
    const challenge = await authorityConsentChallenge(accountId, authority);
    expect(Array.from(new Uint8Array(request.challenge as ArrayBuffer))).toEqual(Array.from(challenge));
    expect(await verifyPasskeyAssertion({ publicKey: authority.publicKey, rpId, origins: [origin], challenge, signature: consent })).toBe(true);
    const other = await authorityConsentChallenge(b64(crypto.getRandomValues(new Uint8Array(32))), authority);
    expect(await verifyPasskeyAssertion({ publicKey: authority.publicKey, rpId, origins: [origin], challenge: other, signature: consent })).toBe(false);
  });

  it('rejects an assertion from a different credential and maps cancellation', async () => {
    const fake = await fakeAuthenticator();
    const other = await createSoftPasskey({ rpId, origin });
    await expect(signAuthorityConsent({ accountId, authority: { credentialId: other.credentialId, publicKey: other.publicKey }, rpId }))
      .rejects.toThrow('passkey_wrong_credential');
    fake.get.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'NotAllowedError' }));
    await expect(signAuthorityConsent({ accountId, authority: { credentialId: fake.passkey.credentialId, publicKey: fake.passkey.publicKey }, rpId }))
      .rejects.toThrow('passkey_cancelled');
  });
});
