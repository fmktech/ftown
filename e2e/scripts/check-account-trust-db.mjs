// ROOT EXECUTION ONLY. Requires Node24.22.1+, the isolated E2E PostgreSQL and installed UI/bridge dependencies.
// From the repository root after the root's resource/selector preflight:
//   node e2e/scripts/check-account-trust-db.mjs
// Never print fixture rows, credentials, signing material or enrollment fragments.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const schema = `ftown_account_check_${randomBytes(10).toString('hex')}`;
const adapterSymbol = Symbol.for('ftown.account-trust-db-acceptance');
const virtualAdapter = 'ftown-account-db-acceptance:adapter';
let stage = 'selector validation';
let admin;
let pool;
let hooks;
let created = false;
let failed = false;
const deadline = performance.now() + 90000;
const randomCode = () => randomBytes(32).toString('base64url');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const safeCode = error => typeof error?.code === 'string' && /^(?:[A-Z0-9_]{2,48}|account_[a-z_]{1,48})$/.test(error.code) ? error.code : 'suppressed';
const safeLine = error => typeof error?.stack === 'string' ? error.stack.match(/check-account-trust-db\.mjs:(\d+):\d+/)?.[1] ?? 'unknown' : 'unknown';

try {
  // Validate every effective selector BEFORE loading a driver or opening a connection.
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  assert.ok(major === 24 && (minor > 22 || (minor === 22 && patch >= 1)), 'Node24.22.1+ required');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert.equal(url.port || '5432', '5432');
  assert.equal(decodeURIComponent(url.pathname.slice(1)), 'ftown');
  assert.equal(decodeURIComponent(url.username), 'ftown');
  assert.equal(url.search, ''); assert.equal(url.hash, '');
  assert.match(process.env.E2E_USER_EMAIL ?? '', /^e2e[^@]*@ftown\.test$/);
  if (process.env.PGHOST !== undefined) assert.ok(['localhost', '127.0.0.1', '::1'].includes(process.env.PGHOST));
  for (const [key, expected] of [['PGPORT', '5432'], ['PGDATABASE', 'ftown'], ['PGUSER', 'ftown']]) {
    if (process.env[key] !== undefined) assert.equal(process.env[key], expected);
  }
  for (const key of ['PGOPTIONS', 'PGSERVICE', 'PGSERVICEFILE']) assert.ok(!process.env[key], 'Unexpected PostgreSQL selector');
  if (process.env.FTOWN_REPO_ROOT !== undefined) assert.equal(resolve(process.env.FTOWN_REPO_ROOT), repo);
  if (process.env.E2E_DIR !== undefined) assert.equal(resolve(process.env.E2E_DIR), join(repo, 'e2e'));
  assert.match(schema, /^ftown_account_check_[a-f0-9]{20}$/);

  const requireE2e = createRequire(join(repo, 'e2e/package.json'));
  const requireUi = createRequire(join(repo, 'ui/package.json'));
  const { Client, Pool } = requireE2e('pg');
  const ts = requireUi('typescript');
  const connection = { host: url.hostname.replace(/^\[|\]$/g, ''), port: 5432, database: 'ftown', user: 'ftown',
    password: decodeURIComponent(url.password), ssl: false, connectionTimeoutMillis: 5000, query_timeout: 10000, statement_timeout: 5000, application_name: 'ftown-account-trust-acceptance' };
  admin = new Client(connection);
  await admin.connect();
  const selectors = await admin.query('SELECT current_database() AS database,current_user AS username');
  assert.equal(selectors.rows[0].database, 'ftown'); assert.equal(selectors.rows[0].username, 'ftown');
  await admin.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  console.log(`Account trust DB acceptance owns temporary schema ${schema}.`);
  pool = new Pool({ ...connection, max: 4, options: `-c search_path=${schema},pg_catalog -c lock_timeout=5000` });
  assert.equal((await pool.query('SELECT current_schema() AS schema')).rows[0].schema, schema);
  const query = async (text, params = []) => {
    assert.ok(performance.now() < deadline, 'Acceptance deadline reached');
    return (await pool.query(text, params)).rows;
  };

  // Load the actual stores and neutral crypto. Only the stores' DB dependency is
  // replaced by this process-local schema-scoped adapter; no app source is changed.
  Object.defineProperty(globalThis, adapterSymbol, { configurable: true, value: Object.freeze({ query }) });
  const accountSource = pathToFileURL(join(repo, 'ui/src/lib/account-trust-store.ts')).href;
  const pairingSource = pathToFileURL(join(repo, 'ui/src/lib/pairing-store.ts')).href;
  const securityRoot = pathToFileURL(join(repo, 'bridge/src/security/')).href;
  const bridgeSourceRoot = pathToFileURL(join(repo, 'bridge/src/')).href;
  hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === '@/lib/db' && [accountSource, pairingSource].includes(context.parentURL)) return { url: virtualAdapter, shortCircuit: true };
      if (specifier.startsWith('@security/')) {
        assert.match(specifier, /^@security\/[a-z-]+$/);
        return { url: new URL(`${specifier.slice(10)}.ts`, securityRoot).href, shortCircuit: true };
      }
      if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(bridgeSourceRoot)) {
        const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
        if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url === virtualAdapter) return { format: 'module', shortCircuit: true,
        source: 'export function getDb(){return globalThis[Symbol.for("ftown.account-trust-db-acceptance")];}' };
      if (url === accountSource || url === pairingSource || (url.startsWith(bridgeSourceRoot) && url.endsWith('.ts'))) {
        const source = ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, isolatedModules: true } }).outputText;
        return { format: 'module', source, shortCircuit: true };
      }
      return next(url, context);
    },
  });
  const { AccountTrustStore, accountHead } = await import(accountSource);
  const pairing = await import(pairingSource);
  const core = await import(new URL('account-crypto.ts', securityRoot).href);
  const { generateEndpoint } = await import(new URL('crypto.ts', securityRoot).href);

  stage = 'populated additive migration';
  // Reuse the canonical schema's pre-0007 prefix, not a second copy of legacy DDL.
  const canonicalSchema = readFileSync(join(repo, 'ui/schema.sql'), 'utf8');
  const marker = '-- Signed public account history is a delivery log, never a trust authority.';
  assert.equal(canonicalSchema.split(marker).length, 2);
  let baseline = canonicalSchema.split(marker)[0];
  assert.ok(baseline.startsWith('CREATE EXTENSION IF NOT EXISTS "pgcrypto";'));
  // gen_random_uuid is built into supported PostgreSQL. Never create an extension
  // outside the owned schema, even if the normal fresh-install schema requests it.
  baseline = baseline.replace(/^CREATE EXTENSION IF NOT EXISTS "pgcrypto";\s*/, '');
  assert.ok(!/CREATE\s+EXTENSION|security_account_|\baccount_approval\b|\bpublic\./i.test(baseline));
  assert.ok((await pool.query("SELECT to_regprocedure('pg_catalog.gen_random_uuid()') IS NOT NULL AS present")).rows[0].present);
  await pool.query(baseline);
  const owner = randomUUID(), foreign = randomUUID(), capacityOwner = randomUUID();
  const email = `e2e-db-${randomBytes(6).toString('hex')}@ftown.test`;
  const legacyCode = randomCode();
  await query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3),($4,$5,$3),($6,$7,$3)',
    [owner, email, 'non-login-fixture-hash', foreign, `e2e-db-${randomUUID()}@ftown.test`, capacityOwner, `e2e-db-${randomUUID()}@ftown.test`]);
  await query('INSERT INTO bridge_refresh(bridge_id,sub,current_jti,hostname,last_seen) VALUES($1,$2,$3,$4,NOW())', ['legacy-bridge', email, randomUUID(), 'Legacy']);
  await query(`INSERT INTO pairing_requests(device_code,user_code,bridge_id,hostname,platform,expires_at)
    VALUES($1,$2,$3,$4,$5,NOW()+INTERVAL '10 minutes')`, [legacyCode, 'LEGA-0001', 'legacy-bridge', 'Legacy', 'linux']);
  await query(`INSERT INTO mcp_oauth_records(kind,key,data,expires_at) VALUES('client',$1,$2::jsonb,NOW()+INTERVAL '10 minutes'),('grant',$3,$4::jsonb,NOW()+INTERVAL '10 minutes')`,
    [randomCode(), JSON.stringify({ fixture: 'client', owner }), randomCode(), JSON.stringify({ fixture: 'grant', owner })]);
  const digest = async client => {
    const result = [];
    for (const table of ['users', 'bridge_refresh', 'pairing_requests', 'mcp_oauth_records']) {
      const rows = await client.query(`SELECT COUNT(*)::int AS count,md5(COALESCE(string_agg((to_jsonb(t)-'enrollment'-'account_approval')::text,'' ORDER BY (to_jsonb(t)-'enrollment'-'account_approval')::text),'')) AS digest FROM ${table} t`);
      result.push(rows.rows[0]);
    }
    return result;
  };
  const migration = readFileSync(join(repo, 'ui/migrations/0007_account_trust.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await digest(client);
    assert.ok(before.every(item => item.count > 0));
    await client.query(migration); assert.deepEqual(await digest(client), before);
    await client.query(migration); assert.deepEqual(await digest(client), before);
    assert.equal((await client.query('SELECT COUNT(*)::int AS count FROM pairing_requests WHERE enrollment IS NOT NULL OR account_approval IS NOT NULL')).rows[0].count, 0);
    assert.equal((await client.query('SELECT COUNT(*)::int AS count FROM security_account_history')).rows[0].count, 0);
    assert.equal((await client.query('SELECT COUNT(*)::int AS count FROM security_account_enrollments')).rows[0].count, 0);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }

  stage = 'signed history CAS and owner isolation';
  const store = new AccountTrustStore(query);
  const adminIdentity = await generateEndpoint(owner, 'browser');
  const adminSigning = await core.generateAccountSigningIdentity();
  const genesis = await core.createAccountGenesis(owner, adminIdentity.endpoint, adminSigning, 'Database admin');
  await store.append(owner, { expectedHead: null, record: genesis });
  let current = await store.readVerified(owner);
  assert.ok(current);
  const baseHead = accountHead(current.checkpoint);
  const records = await Promise.all(['cas-a', 'cas-b'].map(async bridgeId => core.signAccountTransition(current.checkpoint, adminIdentity.endpoint.id, adminSigning,
    { type: 'add_bridge', bridge: { bridgeId, endpoint: (await generateEndpoint(owner, 'bridge')).endpoint, label: bridgeId, approvedAt: new Date().toISOString() } })));
  const attempts = await Promise.allSettled(records.map(record => store.append(owner, { expectedHead: baseHead, record })));
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  const loser = attempts.find(item => item.status === 'rejected');
  assert.equal(loser.reason.code, 'account_trust_conflict');
  await assert.rejects(store.append(owner, { expectedHead: baseHead, record: records[0] }), { code: 'account_trust_conflict' });
  assert.equal(await store.read(foreign), null);
  await assert.rejects(store.append(foreign, { expectedHead: null, record: genesis }), { code: 'invalid_account_trust' });
  current = await store.readVerified(owner);
  const saved = current;
  try {
    await query(`UPDATE security_account_history SET history=jsonb_set(history,'{genesis,signature}',to_jsonb($2::text)) WHERE owner_id=$1`, [owner, 'A'.repeat(86)]);
    await assert.rejects(store.read(owner));
  } finally { await query('UPDATE security_account_history SET history=$2::jsonb WHERE owner_id=$1', [owner, JSON.stringify(saved.history)]); }
  try {
    await query('UPDATE security_account_history SET head=$2 WHERE owner_id=$1', [owner, randomCode()]);
    await assert.rejects(store.read(owner), { code: 'account_storage_unavailable' });
  } finally { await query('UPDATE security_account_history SET head=$2 WHERE owner_id=$1', [owner, saved.checkpoint.head]); }

  stage = 'enrollment persistence and expiry';
  const browser = await generateEndpoint(owner, 'browser');
  const signing = await core.generateAccountSigningIdentity();
  const link = await core.createAccountEnrollment(browser, 'Database candidate', signing, null);
  const pending = await store.createEnrollment(owner, link.request);
  assert.deepEqual(await store.createEnrollment(owner, link.request), pending);
  await assert.rejects(store.enrollment(foreign, link.request.requestId));
  const collision = await core.createAccountEnrollment(browser, 'Different candidate label', signing, null);
  const { signingProof: ignored, ...unsigned } = { ...collision.request, requestId: link.request.requestId };
  assert.ok(ignored);
  const signingProof = Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signing.keyPair.privateKey,
    new TextEncoder().encode('ftown-account-enrollment-v1\n' + canonical(unsigned)))).toString('base64url');
  await assert.rejects(store.createEnrollment(owner, { ...unsigned, signingProof }), { code: 'account_trust_conflict' });
  current = await store.readVerified(owner);
  const addition = await core.signAccountTransition(current.checkpoint, adminIdentity.endpoint.id, adminSigning, { type: 'add_device', device: {
    endpoint: browser.endpoint, signingPublicKey: signing.publicKey, label: link.request.label, approvedAt: new Date().toISOString() } });
  await store.append(owner, { expectedHead: accountHead(current.checkpoint), record: addition });
  current = await store.readVerified(owner);
  const bundle = await core.sealAccountApproval(adminIdentity, link, current.history);
  assert.equal((await store.approveEnrollment(owner, link.request.requestId, { requestId: link.request.requestId, bundle })).status, 'approved');
  const delivered = await store.enrollment(owner, link.request.requestId);
  assert.deepEqual((await core.openAccountApproval(browser, link, delivered.bundle, current.history)).checkpoint, current.checkpoint);
  const publicRows = await query('SELECT request::text AS request,bundle::text AS bundle FROM security_account_enrollments WHERE owner_id=$1', [owner]);
  assert.ok(!JSON.stringify(publicRows).includes(link.secret));
  assert.ok(!/"(?:privateKey|secret|secretProof|key_ops)"\s*:/.test(JSON.stringify(publicRows)));
  const afterExpiry = new AccountTrustStore(query, () => Date.parse(link.request.expiresAt));
  await assert.rejects(afterExpiry.enrollment(owner, link.request.requestId), { code: 'account_enrollment_expired' });

  stage = 'concurrent enrollment capacity';
  const capacityBrowser = await generateEndpoint(capacityOwner, 'browser');
  const capacitySigning = await core.generateAccountSigningIdentity();
  const requests = await Promise.all(Array.from({ length: 129 }, () => core.createAccountEnrollment(capacityBrowser, 'Capacity fixture', capacitySigning, null)));
  const outcomes = [];
  for (let offset = 0; offset < requests.length; offset += 4) {
    outcomes.push(...await Promise.all(requests.slice(offset, offset + 4).map(async item => {
      for (let retry = 0; retry < 8; retry++) {
        try { await store.createEnrollment(capacityOwner, item.request); return 'admitted'; }
        catch (error) {
          if (error.code === 'account_capacity_exceeded') return 'capacity';
          if (error.code !== 'account_trust_conflict' || retry === 7) throw error;
        }
      }
      throw new Error('Unreachable retry state');
    })));
  }
  assert.equal(outcomes.filter(item => item === 'admitted').length, 128);
  assert.equal(outcomes.filter(item => item === 'capacity').length, 1);
  assert.equal((await query('SELECT COUNT(*)::int AS count FROM security_account_enrollments WHERE owner_id=$1', [capacityOwner]))[0].count, 128);

  stage = 'pairing downgrade, expiry and policy CAS';
  const candidate = await core.generateAccountBridgeCandidate('db-account-bridge');
  const bridgeLink = await core.createAccountEnrollment(candidate, 'Database bridge', null, 'db-account-bridge');
  current = await store.readVerified(owner);
  const bridgeRecord = await core.signAccountTransition(current.checkpoint, adminIdentity.endpoint.id, adminSigning, { type: 'add_bridge', bridge: {
    bridgeId: bridgeLink.request.bridgeId, endpoint: { ...candidate.endpoint, ownerId: owner }, label: bridgeLink.request.label, approvedAt: new Date().toISOString() } });
  await store.append(owner, { expectedHead: accountHead(current.checkpoint), record: bridgeRecord });
  current = await store.readVerified(owner);
  const bridgeBundle = await core.sealAccountApproval(adminIdentity, bridgeLink, current.history);
  const deviceCode = randomCode();
  await pairing.createPairingRequest({ deviceCode, userCode: 'ACCT-0001', bridgeId: bridgeLink.request.bridgeId, hostname: 'Database bridge', platform: 'linux', expiresAtIso: bridgeLink.request.expiresAt, enrollment: bridgeLink.request });
  assert.equal(await pairing.approvePairingRequest('ACCT-0001', email, randomUUID()), null);
  assert.equal((await pairing.getByDeviceCode(deviceCode)).status, 'pending');
  await assert.rejects(store.validateApproval(owner, bridgeLink.request, { ...bridgeBundle, envelope: { ...bridgeBundle.envelope, recipientId: adminIdentity.endpoint.id } }));
  assert.equal((await pairing.getByDeviceCode(deviceCode)).status, 'pending');
  let verified = await store.validateApproval(owner, bridgeLink.request, bridgeBundle);
  let binding = { ownerId: owner, head: verified.head, enrollment: verified.request, bundle: verified.bundle };
  assert.equal((await pairing.approvePairingRequest('ACCT-0001', email, randomUUID(), binding)).status, 'approved');
  assert.equal(await pairing.consumePairingRequest(deviceCode), null);
  assert.equal((await pairing.getByDeviceCode(deviceCode)).status, 'approved');
  // A valid competing public transition makes the prepared binding stale.
  current = await store.readVerified(owner);
  const race = await core.signAccountTransition(current.checkpoint, adminIdentity.endpoint.id, adminSigning, { type: 'revoke_bridge', bridgeId: current.checkpoint.bridges.find(item => item.bridgeId.startsWith('cas-')).bridgeId });
  await store.append(owner, { expectedHead: accountHead(current.checkpoint), record: race });
  assert.equal(await pairing.consumePairingRequest(deviceCode, binding), null);
  assert.equal((await pairing.getByDeviceCode(deviceCode)).status, 'approved');
  verified = await store.validateApproval(owner, bridgeLink.request, bridgeBundle, true);
  binding = { ownerId: owner, head: verified.head, enrollment: verified.request, bundle: verified.bundle };
  assert.equal((await pairing.consumePairingRequest(deviceCode, binding)).status, 'consumed');
  const expiredCode = randomCode();
  await pairing.createPairingRequest({ deviceCode: expiredCode, userCode: 'ACCT-0002', bridgeId: bridgeLink.request.bridgeId, hostname: 'Database bridge', platform: 'linux', expiresAtIso: bridgeLink.request.expiresAt, enrollment: bridgeLink.request });
  assert.equal((await pairing.approvePairingRequest('ACCT-0002', email, randomUUID(), binding)).status, 'approved');
  await query("UPDATE pairing_requests SET expires_at=NOW()-INTERVAL '1 second' WHERE device_code=$1", [expiredCode]);
  assert.equal(await pairing.consumePairingRequest(expiredCode, binding), null);
  assert.equal((await pairing.getByDeviceCode(expiredCode)).status, 'approved');
  assert.equal((await pairing.approvePairingRequest('LEGA-0001', email, randomUUID())).status, 'approved');
  const legacy = await pairing.consumePairingRequest(legacyCode);
  assert.equal(legacy.status, 'consumed'); assert.equal(legacy.enrollment, null); assert.equal(legacy.accountApproval, null);
  console.log('PASS: populated0007 twice preserves legacy digests; real signed CAS/owner/tamper checks, enrollment expiry/collision/concurrent128 cap, account pairing guards and legacy consumption.');
} catch (error) {
  failed = true;
  console.error(`FAIL: account trust database acceptance during ${stage}; code=${safeCode(error)}; harnessLine=${safeLine(error)}; fixture details suppressed.`);
} finally {
  hooks?.deregister();
  delete globalThis[adapterSymbol];
  try { await pool?.end(); } catch { failed = true; console.error('FAIL: acceptance pool cleanup.'); }
  if (created && admin) {
    try {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      assert.equal((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) AS present', [schema])).rows[0].present, false);
      console.log(`Verified temporary schema ${schema} removed.`);
    } catch { failed = true; console.error(`FAIL: cleanup incomplete for owned schema ${schema}.`); }
  }
  try { await admin?.end(); } catch { failed = true; console.error('FAIL: acceptance selector connection cleanup.'); }
  if (failed) process.exitCode = 1;
}
