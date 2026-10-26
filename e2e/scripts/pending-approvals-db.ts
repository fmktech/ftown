// ROOT EXECUTION ONLY; Node24.22.1+, installed UI/e2e/bridge dependencies.
// From repository root, after isolated ftown@localhost:5432 preflight:
// DATABASE_URL=... E2E_USER_EMAIL=e2e-...@ftown.test node e2e/scripts/pending-approvals-db.ts
// Uses production stores with a process-local, schema-scoped query adapter.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire, registerHooks } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Client as PgClient, Pool as PgPool } from 'pg';
import type { AccountHistory, AccountEnrollmentRequest } from '../../bridge/src/security/account-protocol.js';
import type { PendingApprovalState, PendingReviewerAction, PendingReviewerCommand } from '../../bridge/src/security/pending-approval-protocol.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const schema = `ftown_pending_check_${randomBytes(10).toString('hex')}`;
const adapterSymbol = Symbol.for('ftown.pending-db-acceptance');
const virtualAdapter = 'ftown-pending-db:adapter';
const virtualAuth = 'ftown-pending-db:unused-auth';
let stage = 'selector validation';
let admin: PgClient | undefined;
let pool: PgPool | undefined;
let hooks: ReturnType<typeof registerHooks> | undefined;
let created = false;
let failed = false;
const deadline = performance.now() + 150000;
const randomCode = () => randomBytes(32).toString('base64url');
const safeCode = (error: unknown) => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
  && /^(?:[A-Z0-9_]{2,48}|account_[a-z_]{1,48})$/.test(error.code) ? error.code : 'suppressed';
const safeLine = (error: unknown) => error instanceof Error ? error.stack?.match(/pending-approvals-db\.ts:(\d+):\d+/)?.[1] ?? 'unknown' : 'unknown';
try {
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  assert.ok(major === 24 && (minor > 22 || (minor === 22 && patch >= 1)), 'Node24.22.1+ required');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert.equal(url.port || '5432', '5432'); assert.equal(decodeURIComponent(url.pathname.slice(1)), 'ftown');
  assert.equal(decodeURIComponent(url.username), 'ftown'); assert.equal(url.search, ''); assert.equal(url.hash, '');
  assert.match(process.env.E2E_USER_EMAIL ?? '', /^e2e[^@]*@ftown\.test$/);
  if (process.env.PGHOST !== undefined) assert.ok(['localhost', '127.0.0.1', '::1'].includes(process.env.PGHOST));
  for (const [key, expected] of [['PGPORT', '5432'], ['PGDATABASE', 'ftown'], ['PGUSER', 'ftown']]) if (process.env[key] !== undefined) assert.equal(process.env[key], expected);
  for (const key of ['PGOPTIONS', 'PGSERVICE', 'PGSERVICEFILE']) assert.ok(!process.env[key]);
  if (process.env.FTOWN_REPO_ROOT !== undefined) assert.equal(resolve(process.env.FTOWN_REPO_ROOT), repo);
  if (process.env.E2E_DIR !== undefined) assert.equal(resolve(process.env.E2E_DIR), join(repo, 'e2e'));
  assert.match(schema, /^ftown_pending_check_[a-f0-9]{20}$/);
  const requireE2e = createRequire(join(repo, 'e2e/package.json')); const requireUi = createRequire(join(repo, 'ui/package.json'));
  const pg: typeof import('pg') = requireE2e('pg'); const ts: typeof import('typescript') = requireUi('typescript');
  const connection = { host: url.hostname.replace(/^\[|\]$/g, ''), port: 5432, database: 'ftown', user: 'ftown', password: decodeURIComponent(url.password), ssl: false,
    connectionTimeoutMillis: 5000, query_timeout: 15000, statement_timeout: 10000, application_name: 'ftown-pending-approval-acceptance' };
  admin = new pg.Client(connection); await admin.connect();
  const selectors = (await admin.query('SELECT current_database() AS database,current_user AS username')).rows[0];
  assert.equal(selectors.database, 'ftown'); assert.equal(selectors.username, 'ftown');
  await admin.query(`CREATE SCHEMA "${schema}"`); created = true;
  pool = new pg.Pool({ ...connection, max: 8, options: `-c search_path=${schema},pg_catalog -c lock_timeout=5000` });
  const ownedPool = pool;
  assert.equal((await ownedPool.query('SELECT current_schema() AS schema')).rows[0].schema, schema);
  const query = async (text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> => {
    assert.ok(performance.now() < deadline, 'Acceptance deadline reached'); return (await ownedPool.query(text, params)).rows;
  };
  Object.defineProperty(globalThis, adapterSymbol, { configurable: true, value: Object.freeze({ query }) });
  const uiRoot = pathToFileURL(join(repo, 'ui/src/')).href;
  const securityRoot = pathToFileURL(join(repo, 'bridge/src/security/')).href;
  const bridgeRoot = pathToFileURL(join(repo, 'bridge/src/')).href;
  hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === '@/lib/auth' && context.parentURL?.startsWith(uiRoot)) return { url: virtualAuth, shortCircuit: true };
      if (specifier === 'next/server' && context.parentURL?.startsWith(uiRoot)) return { url: pathToFileURL(requireUi.resolve('next/server')).href, shortCircuit: true };
      if (specifier === '@/lib/db' && context.parentURL?.startsWith(uiRoot)) return { url: virtualAdapter, shortCircuit: true };
      if (specifier.startsWith('@/lib/') && context.parentURL?.startsWith(uiRoot)) {
        assert.match(specifier, /^@\/lib\/[a-z-]+$/); return { url: new URL(specifier.slice(2) + '.ts', uiRoot).href, shortCircuit: true };
      }
      if (specifier.startsWith('@security/')) {
        assert.match(specifier, /^@security\/[a-z-]+$/); return { url: new URL(specifier.slice(10) + '.ts', securityRoot).href, shortCircuit: true };
      }
      // UI helpers also import bridge source through extensionless relative paths.
      if (specifier.startsWith('.') && (specifier.endsWith('.js') || !/\.[^/]+$/.test(specifier))
        && (context.parentURL?.startsWith(uiRoot) || context.parentURL?.startsWith(bridgeRoot))) {
        const candidate = new URL((specifier.endsWith('.js') ? specifier.slice(0, -3) : specifier) + '.ts', context.parentURL);
        if ((candidate.href.startsWith(uiRoot) || candidate.href.startsWith(bridgeRoot)) && existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url === virtualAuth) return { format: 'module', shortCircuit: true, source: 'export async function auth(){throw new Error("Authentication must not run in store acceptance");}' };
      if (url === virtualAdapter) return { format: 'module', shortCircuit: true, source: 'export function getDb(){return globalThis[Symbol.for("ftown.pending-db-acceptance")];}' };
      if ((url.startsWith(uiRoot) || url.startsWith(bridgeRoot)) && url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
        source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, isolatedModules: true } }).outputText };
      return next(url, context);
    },
  });
  const { PendingApprovalStore, PENDING_NORMALIZED_EMAIL_SQL } = await import(new URL('lib/pending-approval-store.ts', uiRoot).href);
  const { AccountTrustStore, accountHead } = await import(new URL('lib/account-trust-store.ts', uiRoot).href);
  const pairing = await import(new URL('lib/pairing-store.ts', uiRoot).href);
  const { accountRateLimit, accountError } = await import(new URL('app/api/security/account/_shared.ts', uiRoot).href);
  const core = await import(new URL('account-crypto.ts', securityRoot).href) as typeof import('../../bridge/src/security/account-crypto.js');
  const pending = await import(new URL('pending-approval-crypto.ts', securityRoot).href) as typeof import('../../bridge/src/security/pending-approval-crypto.js');
  const { generateEndpoint } = await import(new URL('crypto.ts', securityRoot).href) as typeof import('../../bridge/src/security/crypto.js');

  stage = 'populated additive0008 repeat migration';
  let baseline = readFileSync(join(repo, 'ui/schema.sql'), 'utf8').split('-- Pending approvals (0008):')[0];
  baseline = baseline.replace(/^CREATE EXTENSION IF NOT EXISTS "pgcrypto";\s*/, '');
  assert.ok(!/CREATE\s+EXTENSION|security_pending_approvals|\bpublic\./i.test(baseline));
  await query(baseline);
  const owner = randomUUID(), foreign = randomUUID(); const email = `e2e-db-${randomUUID()}@ftown.test`; const legacyCode = randomCode();
  await query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3),($4,$5,$3)', [owner, email, 'non-login-fixture', foreign, `e2e-db-${randomUUID()}@ftown.test`]);
  stage = 'account request window exact threshold, isolation and repeated recovery';
  const rateRow = async (scope: string, key = owner) => (await query('SELECT failed_count,locked_until,updated_at FROM rate_limit_attempts WHERE scope=$1 AND key=$2', [scope, key]))[0];
  const expireRateWindow = (scope: string, key = owner) => query("UPDATE rate_limit_attempts SET updated_at=statement_timestamp()-INTERVAL '60 seconds' WHERE scope=$1 AND key=$2", [scope, key]);
  const deniedRate = async (scope: string, limit: number, key = owner) => {
    const outcome = await accountRateLimit(key, scope, limit).then(() => null, (error: unknown) => error);
    assert.ok(outcome, 'Over-budget request must be denied');
    const response = accountError(outcome); assert.equal(response.status, 429);
    const retryAfter = Number(response.headers.get('retry-after'));
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60);
    assert.deepEqual(await response.json(), { error: 'rate_limited' });
  };
  // More than one lifetime budget remains usable across successive fixed windows.
  for (let window = 0; window < 4; window++) {
    if (window) await expireRateWindow('account-read');
    await accountRateLimit(owner, 'account-read', 3);
    const first = await rateRow('account-read'); assert.equal(first.failed_count, 1);
    for (let request = 1; request < 3; request++) await accountRateLimit(owner, 'account-read', 3);
    assert.deepEqual((await rateRow('account-read')).updated_at, first.updated_at);
    for (let request = 0; request < 4; request++) await deniedRate('account-read', 3);
    const last = await rateRow('account-read');
    assert.deepEqual(last.updated_at, first.updated_at); assert.equal(last.failed_count, 4);
  }
  // A different scope or owner has an independent budget.
  await accountRateLimit(owner, 'account-write', 3); await accountRateLimit(foreign, 'account-read', 3);
  assert.equal((await rateRow('account-write')).failed_count, 1);
  assert.equal((await rateRow('account-read', foreign)).failed_count, 1);
  stage = 'account request window concurrent admission cap';
  const rateRace = await Promise.allSettled(Array.from({ length: 32 }, () => accountRateLimit(owner, 'account-read-race', 7)));
  assert.equal(rateRace.filter(result => result.status === 'fulfilled').length, 7);
  for (const result of rateRace) if (result.status === 'rejected') assert.equal(accountError(result.reason).status, 429);
  assert.equal((await rateRow('account-read-race')).failed_count, 8);
  stage = 'legacy over-threshold account counter ignores stale lock and recovers';
  await query("INSERT INTO rate_limit_attempts(scope,key,failed_count,locked_until,updated_at) VALUES('account-read-legacy',$1,346,statement_timestamp()+INTERVAL '1 day',statement_timestamp()-INTERVAL '61 seconds')", [owner]);
  await accountRateLimit(owner, 'account-read-legacy', 300);
  const recoveredRate = await rateRow('account-read-legacy');
  assert.equal(recoveredRate.failed_count, 1); assert.equal(recoveredRate.locked_until, null);
  // A recent legacy row waits only for its original 60-second window, regardless of locked_until.
  await query("UPDATE rate_limit_attempts SET failed_count=346,locked_until=statement_timestamp()+INTERVAL '1 day' WHERE scope='account-read-legacy' AND key=$1", [owner]);
  const legacyAnchor = (await rateRow('account-read-legacy')).updated_at;
  await deniedRate('account-read-legacy', 300);
  assert.deepEqual((await rateRow('account-read-legacy')).updated_at, legacyAnchor);
  await expireRateWindow('account-read-legacy'); await accountRateLimit(owner, 'account-read-legacy', 300);
  assert.equal((await rateRow('account-read-legacy')).failed_count, 1);

  await query('INSERT INTO bridge_refresh(bridge_id,sub,current_jti,hostname,last_seen) VALUES($1,$2,$3,$4,NOW())', ['legacy-bridge', email, randomUUID(), 'Legacy']);
  await pairing.createPairingRequest({ deviceCode: legacyCode, userCode: 'LEGA-0001', bridgeId: 'legacy-bridge', hostname: 'Legacy', platform: 'linux', expiresAtIso: new Date(Date.now() + 600000).toISOString() });
  const accounts = new AccountTrustStore(query);
  const adminIdentity = await generateEndpoint(owner, 'browser'); const adminSigning = await core.generateAccountSigningIdentity();
  const genesis = await core.createAccountGenesis(owner, adminIdentity.endpoint, adminSigning, 'Database admin');
  await accounts.append(owner, { expectedHead: null, record: genesis });
  const oldBrowser = await generateEndpoint(owner, 'browser'); const oldSigning = await core.generateAccountSigningIdentity();
  await accounts.createEnrollment(owner, (await core.createAccountEnrollment(oldBrowser, 'Legacy request', oldSigning, null)).request);
  await query("INSERT INTO mcp_oauth_records(kind,key,data,expires_at) VALUES('client',$1,$2::jsonb,NOW()+INTERVAL '10 minutes')", [randomCode(), JSON.stringify({ fixture: true })]);
  const legacyDigest = async () => {
    const output = [];
    for (const table of ['users', 'bridge_refresh', 'pairing_requests', 'security_account_history', 'security_account_enrollments', 'mcp_oauth_records']) {
      output.push((await query(`SELECT COUNT(*)::int AS count,md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) AS digest FROM ${table} t`))[0]);
    }
    return output;
  };
  const before = await legacyDigest(); assert.ok(before.every(item => Number(item.count) > 0));
  const migration = readFileSync(join(repo, 'ui/migrations/0008_pending_approvals.sql'), 'utf8');
  assert.ok(!/ALTER\s+TABLE|REFERENCES|\bDELETE\b|\bUPDATE\b/i.test(migration));
  assert.ok(!/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im.test(migration), 'Migration caller must own the transaction');
  // Run the real runner, not a copy of its loop. This child is restricted to the
  // already verified database and newly owned schema; no inherited remote URL.
  const runnerUrl = new URL(url.href);
  runnerUrl.searchParams.set('options', `-c search_path=${schema},pg_catalog -c lock_timeout=5000`);
  runnerUrl.searchParams.set('sslmode', 'disable');
  assert.equal(runnerUrl.protocol, url.protocol); assert.equal(runnerUrl.hostname, url.hostname);
  assert.equal(runnerUrl.password, url.password); assert.equal(runnerUrl.pathname, '/ftown');
  assert.equal(runnerUrl.username, 'ftown'); assert.equal(runnerUrl.port || '5432', '5432');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(runnerUrl.hostname));
  assert.deepEqual([...runnerUrl.searchParams.keys()].sort(), ['options', 'sslmode']);
  assert.equal(runnerUrl.searchParams.get('options'), `-c search_path=${schema},pg_catalog -c lock_timeout=5000`);
  const runActualMigrator = () => spawnSync(process.execPath, [join(repo, 'ui/scripts/migrate.mjs')], {
    cwd: repo, timeout: 30000, maxBuffer: 1024 * 1024, encoding: 'utf8',
    env: { ...process.env, MIGRATION_DATABASE_URL: runnerUrl.href, DATABASE_URL: runnerUrl.href },
  });
  await query(`CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT reject_pending_tracking CHECK(name<>'0008_pending_approvals.sql'))`);
  for (const name of readdirSync(join(repo, 'ui/migrations')).filter(name => name.endsWith('.sql') && name !== '0008_pending_approvals.sql')) {
    assert.match(name, /^[0-9]{4}_[a-z0-9_]+\.sql$/);
    await query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
  }
  stage = 'actual runner rollback on tracking failure';
  const rejectedMigration = runActualMigrator();
  assert.equal(rejectedMigration.error, undefined); assert.equal(rejectedMigration.status, 1);
  assert.match(rejectedMigration.stderr, /reject_pending_tracking/); assert.match(rejectedMigration.stderr, /0008_pending_approvals\.sql/);
  assert.equal((await query("SELECT to_regclass('security_pending_approvals') IS NULL AS absent"))[0].absent, true);
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM schema_migrations WHERE name='0008_pending_approvals.sql'"))[0].n, 0);
  assert.deepEqual(await legacyDigest(), before);
  stage = 'actual runner successful tracking and idempotency';
  await query('ALTER TABLE schema_migrations DROP CONSTRAINT reject_pending_tracking');
  for (let attempt = 0; attempt < 2; attempt++) {
    const appliedMigration = runActualMigrator(); assert.equal(appliedMigration.error, undefined); assert.equal(appliedMigration.status, 0);
    assert.equal((await query("SELECT COUNT(*)::int AS n FROM schema_migrations WHERE name='0008_pending_approvals.sql'"))[0].n, 1);
    assert.deepEqual(await legacyDigest(), before);
  }
  const migrationClient = await ownedPool.connect();
  try {
    const timeouts = (await migrationClient.query("SELECT current_setting('lock_timeout') AS lock,current_setting('statement_timeout') AS statement")).rows[0];
    for (let attempt = 0; attempt < 2; attempt++) {
      await migrationClient.query('BEGIN');
      try {
        await migrationClient.query(migration);
        assert.deepEqual((await migrationClient.query("SELECT current_setting('lock_timeout') AS lock,current_setting('statement_timeout') AS statement")).rows[0], { lock: '5s', statement: '30s' });
        await migrationClient.query('COMMIT');
      } catch (error) { await migrationClient.query('ROLLBACK'); throw error; }
      assert.deepEqual((await migrationClient.query("SELECT current_setting('lock_timeout') AS lock,current_setting('statement_timeout') AS statement")).rows[0], timeouts);
    }
  } finally { migrationClient.release(); }
  assert.deepEqual(await legacyDigest(), before);
  assert.equal((await query('SELECT COUNT(*)::int AS count FROM security_pending_approvals'))[0].count, 0);

  stage = 'ASCII routing normalization and immutable owner ambiguity';
  for (const value of ['\vAlice@EXAMPLE.test\v', 'vAlice@EXAMPLE.test', 'ÄLICE@ExÄMPLE.test', ' alice@example.test\r\n']) {
    const result = await query(`SELECT ${PENDING_NORMALIZED_EMAIL_SQL} AS normalized FROM (SELECT $1::text AS email) fixture`, [value]);
    assert.equal(result[0].normalized, pending.normalizePendingAccountHint(value));
  }
  const store = new PendingApprovalStore(query);
  const aliasOwner = randomUUID();
  await query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [aliasOwner, email.toUpperCase(), 'non-login-fixture']);
  await assert.rejects(store.inbox(owner), { code: 'account_trust_conflict' });
  await query('DELETE FROM users WHERE id=$1', [aliasOwner]);
  assert.deepEqual(await store.inbox(owner), { requests: [] });

  async function ceremony(kind: 'browser' | 'bridge' = 'browser') {
    const startedAt = Date.now(); const bridgeId = `db-${randomBytes(8).toString('hex')}`;
    const candidate = kind === 'browser' ? await generateEndpoint(owner, 'browser') : await core.generateAccountBridgeCandidate(bridgeId);
    const signing = kind === 'browser' ? await core.generateAccountSigningIdentity() : null;
    const link = await core.createAccountEnrollment(candidate, 'Database candidate', signing, kind === 'bridge' ? bridgeId : null, startedAt);
    const candidateToken = randomCode(); let pair: { deviceCode: string; userCode: string } | null = null;
    let state: PendingApprovalState;
    if (link.request.kind === 'bridge') {
      const input = { approvalMethod: 'pending-v1', accountHint: email.toUpperCase(), candidateToken, enrollment: link.request, bridgeId, hostname: 'Database candidate', platform: 'linux' };
      const created = await store.startBridge(input); state = created.state; pair = created.pair;
      assert.deepEqual(await store.startBridge(input), created);
      assert.equal(await pairing.denyPairingRequest(created.pair.userCode), false);
      assert.equal(await pairing.approvePairingRequest(created.pair.userCode, email, randomUUID()), null);
      assert.equal(await pairing.consumePairingRequest(created.pair.deviceCode), null);
    } else state = await store.createBrowser(owner, { request: link.request, candidateToken });
    assert.deepEqual(await store.candidate(link.request.requestId, { candidateToken, action: { type: 'read' } }), state);
    await assert.rejects(store.read(foreign, link.request.requestId));
    await assert.rejects(store.candidate(link.request.requestId, { candidateToken: randomCode(), action: { type: 'read' } }));
    const base = await accounts.readVerified(owner); assert.ok(base);
    const local = await pending.createPendingOffer(link.request, adminIdentity, adminSigning, base.history);
    const review = async (action: PendingReviewerAction, revision = state.revision): Promise<PendingReviewerCommand> => {
      const current = await accounts.readVerified(owner); assert.ok(current);
      return pending.signPendingAction({ type: 'ftown_pending_action', version: 1, requestId: link.request.requestId, ownerId: owner,
        signerId: adminIdentity.endpoint.id, head: accountHead(current.checkpoint), expectedRevision: revision, issuedAt: new Date().toISOString(), action }, adminSigning);
    };
    const reviewCommand = await review({ type: 'review', offer: local.offer });
    state = await store.reviewer(owner, link.request.requestId, reviewCommand);
    assert.deepEqual(await store.reviewer(owner, link.request.requestId, reviewCommand), state);
    const hello = await pending.createPendingHello(candidate, local.offer); const offerHash = await pending.pendingOfferHash(local.offer);
    const helloCommand = { candidateToken, action: { type: 'hello', expectedRevision: state.revision, hello: hello.hello } };
    state = await store.candidate(link.request.requestId, helloCommand);
    assert.deepEqual(await store.candidate(link.request.requestId, helloCommand), state);
    const secret = await pending.openPendingHello(adminIdentity, local, hello.hello);
    const reveal = { offerHash, contribution: local.contribution };
    state = await store.reviewer(owner, link.request.requestId, await review({ type: 'reveal', offerHash, helloHash: await pending.pendingHelloHash(hello.hello), reveal }));
    const confirmation = await pending.createPendingConfirmation(local.offer, hello.secret, reveal, offerHash);
    state = await store.candidate(link.request.requestId, { candidateToken, action: { type: 'confirm', expectedRevision: state.revision, confirmation } });
    const current = await accounts.readVerified(owner); assert.ok(current);
    const operation = link.request.kind === 'browser' ? { type: 'add_device' as const, device: {
      endpoint: candidate.endpoint, signingPublicKey: link.request.signingPublicKey, label: link.request.label, approvedAt: new Date().toISOString() } }
      : { type: 'add_bridge' as const, bridge: { bridgeId, endpoint: { ...candidate.endpoint, ownerId: owner }, label: link.request.label, approvedAt: new Date().toISOString() } };
    const transition = await core.signAccountTransition(current.checkpoint, adminIdentity.endpoint.id, adminSigning, operation);
    const history: AccountHistory = { ...current.history, transitions: [...current.history.transitions, transition] };
    const result = await pending.createPendingResult(adminIdentity, local, secret, confirmation, offerHash, history);
    const final = await review({ type: 'finish', offerHash, transition, result });
    return { candidate, link, candidateToken, pair, local, hello, secret, reveal, confirmation, offerHash, state, history, final, review, result };
  }
  stage = 'real final CAS and duplicate operation delivery';
  const browser = await ceremony(); const revisionBefore = (await accounts.readVerified(owner)).checkpoint.revision;
  const firstFinal = await Promise.all([store.reviewer(owner, browser.link.request.requestId, browser.final), store.reviewer(owner, browser.link.request.requestId, browser.final)]);
  assert.ok(firstFinal.every(state => state.status === 'approved'));
  assert.equal((await accounts.readVerified(owner)).checkpoint.revision, revisionBefore + 1);
  assert.equal((await store.read(owner, browser.link.request.requestId)).status, 'approved');
  const currentHistory = (await accounts.readVerified(owner)).history;
  assert.equal((await pending.openPendingResult(browser.candidate, browser.local.offer, browser.hello.secret, browser.reveal, browser.offerHash, browser.result, currentHistory)).status, 'verified');

  stage = 'cancel versus final all-or-zero race';
  const racing = await ceremony('bridge'); const raceBefore = (await accounts.readVerified(owner)).checkpoint.revision;
  const race = await Promise.allSettled([
    store.reviewer(owner, racing.link.request.requestId, racing.final),
    store.candidate(racing.link.request.requestId, { candidateToken: racing.candidateToken, action: { type: 'cancel', expectedRevision: racing.state.revision } }),
  ]);
  assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
  const raceState = await store.read(owner, racing.link.request.requestId);
  const pairState = await pairing.getByDeviceCode(racing.pair!.deviceCode);
  const raceAfter = (await accounts.readVerified(owner)).checkpoint.revision;
  if (raceState.status === 'approved') { assert.equal(raceAfter, raceBefore + 1); assert.equal(pairState.status, 'approved'); }
  else { assert.equal(raceState.status, 'cancelled'); assert.equal(raceAfter, raceBefore); assert.equal(pairState.status, 'pending'); }

  stage = 'stale head and forced downstream zero roll back every participant';
  const stale = await ceremony('bridge'); const staleBefore = await accounts.readVerified(owner);
  const otherBridge = await generateEndpoint(owner, 'bridge');
  const extra = await core.signAccountTransition(staleBefore.checkpoint, adminIdentity.endpoint.id, adminSigning,
    { type: 'add_bridge', bridge: { bridgeId: 'competing-db-bridge', endpoint: otherBridge.endpoint, label: 'Competing', approvedAt: new Date().toISOString() } });
  await accounts.append(owner, { expectedHead: accountHead(staleBefore.checkpoint), record: extra });
  await assert.rejects(store.reviewer(owner, stale.link.request.requestId, stale.final), { code: 'account_trust_conflict' });
  assert.equal((await store.read(owner, stale.link.request.requestId)).status, 'confirmed');
  assert.equal((await pairing.getByDeviceCode(stale.pair!.deviceCode)).status, 'pending');
  const blocked = await ceremony('bridge'); const blockedHead = (await accounts.readVerified(owner)).checkpoint.head;
  // A transaction-local test trigger simulates an unexpected downstream zero. The
  // production all-or-zero assertion must abort the preceding history/state writes.
  await query(`CREATE FUNCTION pending_test_skip() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.device_code='${blocked.pair!.deviceCode}' AND NEW.status='approved' THEN RETURN NULL; END IF; RETURN NEW; END $$`);
  await query('CREATE TRIGGER pending_test_skip BEFORE UPDATE ON pairing_requests FOR EACH ROW EXECUTE FUNCTION pending_test_skip()');
  await assert.rejects(store.reviewer(owner, blocked.link.request.requestId, blocked.final), { code: '22012' });
  assert.equal((await accounts.readVerified(owner)).checkpoint.head, blockedHead);
  assert.equal((await store.read(owner, blocked.link.request.requestId)).status, 'confirmed');
  assert.equal((await pairing.getByDeviceCode(blocked.pair!.deviceCode)).status, 'pending');
  await query('DROP TRIGGER pending_test_skip ON pairing_requests'); await query('DROP FUNCTION pending_test_skip()');

  stage = 'immutable credential delivery, renewal, rotation/revocation replay denial';
  await store.reviewer(owner, blocked.link.request.requestId, blocked.final);
  const deliveries = await Promise.all([store.deliver(blocked.pair!.deviceCode, 23456), store.deliver(blocked.pair!.deviceCode, 34567)]);
  assert.ok(deliveries.every(result => 'snapshot' in result));
  assert.deepEqual(deliveries[0].snapshot, deliveries[1].snapshot);
  const snapshot = deliveries[0].snapshot;
  const replay = await store.deliver(blocked.pair!.deviceCode, 45678); assert.deepEqual(replay.snapshot, snapshot);
  const renewHistory = await accounts.readVerified(owner);
  const renewedResult = await pending.createPendingResult(adminIdentity, blocked.local, blocked.secret, blocked.confirmation, blocked.offerHash, blocked.history);
  const approvedState = await store.read(owner, blocked.link.request.requestId);
  const renewal = await pending.signPendingAction({ type: 'ftown_pending_action', version: 1, requestId: blocked.link.request.requestId, ownerId: owner,
    signerId: adminIdentity.endpoint.id, head: accountHead(renewHistory.checkpoint), expectedRevision: approvedState.revision, issuedAt: new Date().toISOString(),
    action: { type: 'renew', offerHash: blocked.offerHash, result: renewedResult } }, adminSigning);
  const renewed = await store.reviewer(owner, blocked.link.request.requestId, renewal); assert.deepEqual(renewed.result, renewedResult);
  assert.equal((await accounts.readVerified(owner)).checkpoint.head, renewHistory.checkpoint.head);
  assert.equal((await pairing.getByDeviceCode(blocked.pair!.deviceCode)).status, 'consumed');
  assert.deepEqual((await store.candidate(blocked.link.request.requestId, { candidateToken: blocked.candidateToken, action: { type: 'read' } })).result, renewedResult);
  for (const jti of [randomUUID(), 'revoked']) {
    await query('UPDATE bridge_refresh SET current_jti=$2 WHERE bridge_id=$1', [snapshot.bridgeId, jti]);
    assert.deepEqual(await store.deliver(blocked.pair!.deviceCode, 23456), { status: 'denied' });
    assert.equal((await query('SELECT current_jti FROM bridge_refresh WHERE bridge_id=$1', [snapshot.bridgeId]))[0].current_jti, jti);
  }
  await query("UPDATE security_pending_approvals SET expires_at=NOW()-INTERVAL '1 second' WHERE request_id=$1", [blocked.link.request.requestId]);
  assert.deepEqual(await store.deliver(blocked.pair!.deviceCode, 23456), { status: 'expired' });

  stage = 'first-delivery refresh predecessor CAS';
  for (const scenario of ['unchanged', 'rotate', 'revoke', 'repeated-revoked', 'delete-reinsert', 'absent-insert'] as const) {
    const attempt = await ceremony('bridge');
    assert.equal(attempt.link.request.kind, 'bridge');
    if (attempt.link.request.kind !== 'bridge') throw new Error('fixture kind');
    const bridgeId = attempt.link.request.bridgeId;
    const originalJti = scenario === 'repeated-revoked' ? 'revoked' : randomUUID();
    if (scenario !== 'absent-insert') await query(`INSERT INTO bridge_refresh(bridge_id,sub,current_jti,hostname,updated_at)
      VALUES($1,$2,$3,'Predecessor','2026-10-25T00:00:00Z')`, [bridgeId, email, originalJti]);
    await store.reviewer(owner, attempt.link.request.requestId, attempt.final);
    const baseline = (await query('SELECT refresh_predecessor FROM security_pending_approvals WHERE request_id=$1', [attempt.link.request.requestId]))[0].refresh_predecessor;
    if (scenario === 'absent-insert') assert.deepEqual(baseline, { status: 'absent' });
    else assert.deepEqual(Object.keys(baseline as object).sort(), ['jti', 'status', 'sub', 'version']);
    if (scenario === 'rotate') await query('UPDATE bridge_refresh SET current_jti=$2 WHERE bridge_id=$1', [bridgeId, randomUUID()]);
    if (scenario === 'revoke' || scenario === 'repeated-revoked') await query("UPDATE bridge_refresh SET current_jti='revoked' WHERE bridge_id=$1", [bridgeId]);
    if (scenario === 'delete-reinsert') {
      await query('DELETE FROM bridge_refresh WHERE bridge_id=$1', [bridgeId]);
      await query(`INSERT INTO bridge_refresh(bridge_id,sub,current_jti,hostname,updated_at) VALUES($1,$2,$3,'Predecessor','2026-10-25T00:00:00Z')`, [bridgeId, email, originalJti]);
    }
    if (scenario === 'absent-insert') await query(`INSERT INTO bridge_refresh(bridge_id,sub,current_jti,hostname) VALUES($1,$2,$3,'New row')`, [bridgeId, email, originalJti]);
    const refreshBefore = await query('SELECT to_jsonb(r) AS row,r.xmin::text AS xmin,r.ctid::text AS tid FROM bridge_refresh r WHERE bridge_id=$1', [bridgeId]);
    // Exact final replay must never replace the original predecessor with a later
    // revoked/rotated/reinserted version, even though the signed head is now stale.
    assert.equal((await store.reviewer(owner, attempt.link.request.requestId, attempt.final)).status, 'approved');
    assert.deepEqual((await query('SELECT refresh_predecessor FROM security_pending_approvals WHERE request_id=$1', [attempt.link.request.requestId]))[0].refresh_predecessor, baseline);
    if (scenario === 'unchanged') {
      const issued = await Promise.all([store.deliver(attempt.pair!.deviceCode, 23456), store.deliver(attempt.pair!.deviceCode, 34567)]);
      assert.ok(issued.every(value => 'snapshot' in value)); assert.deepEqual(issued[0].snapshot, issued[1].snapshot);
      assert.notEqual(issued[0].snapshot.jti, originalJti);
      assert.equal((await query('SELECT current_jti FROM bridge_refresh WHERE bridge_id=$1', [bridgeId]))[0].current_jti, issued[0].snapshot.jti);
    } else {
      assert.deepEqual(await store.deliver(attempt.pair!.deviceCode, 23456), { status: 'denied' });
      assert.deepEqual(await query('SELECT to_jsonb(r) AS row,r.xmin::text AS xmin,r.ctid::text AS tid FROM bridge_refresh r WHERE bridge_id=$1', [bridgeId]), refreshBefore);
      assert.equal((await pairing.getByDeviceCode(attempt.pair!.deviceCode)).status, 'approved');
      assert.equal((await query('SELECT credential_snapshot FROM security_pending_approvals WHERE request_id=$1', [attempt.link.request.requestId]))[0].credential_snapshot, null);
    }
  }

  stage = 'hard target/global slots, collisions and bounded cleanup';
  // Capacity fixtures are public inert rows, not duplicated application SQL.
  // Direct inserts exercise schema constraints; admission is still production store.
  await query('DELETE FROM security_pending_approvals');
  const capacityIdentity = await core.generateAccountBridgeCandidate('capacity');
  const capacityLink = await core.createAccountEnrollment(capacityIdentity, 'Capacity', null, 'capacity');
  const inert = { request: capacityLink.request, status: 'pending', revision: 0 };
  const fill = async (count: number, target: string, targetStart = 0) => query(`INSERT INTO security_pending_approvals(request_id,target_sub,candidate_token_hash,create_digest,request,state,expires_at,target_slot,global_slot)
    SELECT 'capacity-'||s,$2||CASE WHEN $3::boolean THEN '' ELSE '-'||(s/128)::text END,'inert','inert',$4::jsonb,$5::jsonb,NOW()+INTERVAL '5 minutes',s%128,s FROM generate_series($6::int,$1::int-1) s`,
    [count, target, targetStart === 1, JSON.stringify(capacityLink.request), JSON.stringify(inert), targetStart === 1 ? 0 : targetStart]);
  const raceAdmission = async (target: string, hostname: string) => {
    const requests = await Promise.all([0, 1].map(() => core.createAccountEnrollment(capacityIdentity, 'Capacity', null, 'capacity')));
    const beforePairs = Number((await query('SELECT COUNT(*)::int AS n FROM pairing_requests'))[0].n);
    const results = await Promise.allSettled(requests.map(link => store.startBridge({ approvalMethod: 'pending-v1', accountHint: target,
      candidateToken: randomCode(), enrollment: link.request, bridgeId: 'capacity', hostname, platform: null })));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const failure = results.find(result => result.status === 'rejected'); assert.ok(failure && failure.status === 'rejected');
    assert.equal(failure.reason.code, 'account_capacity_exceeded');
    assert.equal(Number((await query('SELECT COUNT(*)::int AS n FROM pairing_requests'))[0].n), beforePairs + 1);
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM pairing_requests b LEFT JOIN security_pending_approvals p ON p.pair_device_code=b.device_code WHERE b.hostname=$1 AND p.request_id IS NULL', [hostname]))[0].n, 0);
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM (SELECT target_sub,target_slot FROM security_pending_approvals GROUP BY target_sub,target_slot HAVING COUNT(*)>1) duplicates'))[0].n, 0);
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM (SELECT global_slot FROM security_pending_approvals GROUP BY global_slot HAVING COUNT(*)>1) duplicates'))[0].n, 0);
  };
  await fill(127, 'full@ftown.test', 1);
  await raceAdmission('full@ftown.test', 'Capacity race target');
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM security_pending_approvals WHERE target_sub=$1', ['full@ftown.test']))[0].n, 128);
  await query('DELETE FROM security_pending_approvals'); await fill(4095, 'global@ftown.test');
  await raceAdmission('new@ftown.test', 'Capacity race global');
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM security_pending_approvals'))[0].n, 4096);
  await query("UPDATE security_pending_approvals SET expires_at=NOW()-INTERVAL '1 second'");
  const admitted = await store.startBridge({ approvalMethod: 'pending-v1', accountHint: 'new@ftown.test', candidateToken: randomCode(), enrollment: capacityLink.request, bridgeId: 'capacity', hostname: null, platform: null });
  assert.equal(admitted.state.status, 'pending');
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM security_pending_approvals'))[0].n, 3097);
  await assert.rejects(query('UPDATE security_pending_approvals SET global_slot=4096 WHERE request_id=$1', [capacityLink.request.requestId]), { code: '23514' });
  // Legacy auth-only behavior remains usable after expansion and pending guards.
  assert.equal((await pairing.approvePairingRequest('LEGA-0001', email, randomUUID())).status, 'approved');
  assert.equal((await pairing.consumePairingRequest(legacyCode)).status, 'consumed');
  console.log('PASS: atomic account request windows (exact threshold, fixed anchor, repeated recovery, concurrent cap, scope/owner isolation, legacy counter recovery); actual runner atomic tracking rollback/idempotency and bounded caller-owned0008 preserve legacy rows; exact ASCII/owner routing; real signed atomic final/replay/cancel/stale/rollback; immutable credential replay/renew/revoke and first-delivery predecessor CAS; hard target/global slots and bounded cleanup; legacy pairing.');
} catch (error) {
  failed = true; console.error(`FAIL: pending approval DB acceptance during ${stage}; code=${safeCode(error)}; harnessLine=${safeLine(error)}; fixture details suppressed.`);
} finally {
  hooks?.deregister(); delete (globalThis as Record<symbol, unknown>)[adapterSymbol];
  try { await pool?.end(); } catch { failed = true; console.error('FAIL: pending acceptance pool cleanup.'); }
  if (created && admin) {
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); assert.equal((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) AS present', [schema])).rows[0].present, false); console.log(`Verified temporary schema ${schema} removed.`); }
    catch { failed = true; console.error(`FAIL: cleanup incomplete for owned schema ${schema}.`); }
  }
  try { await admin?.end(); } catch { failed = true; console.error('FAIL: pending acceptance selector cleanup.'); }
  if (failed) process.exitCode = 1;
}
