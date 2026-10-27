import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const indexTree = ts.createSourceFile('index.ts', indexSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const statements: ts.Statement[] = [];
function collect(node: ts.Node): void {
  if (ts.isStatement(node)) statements.push(node);
  ts.forEachChild(node, collect);
}
collect(indexTree);
function one(predicate: (node: ts.Statement) => boolean): ts.Statement {
  const found = statements.filter(predicate);
  assert.equal(found.length, 1, 'Expected one matching startup statement');
  return found[0];
}
const declaration = (name: string) => one(node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(item => item.name.getText(indexTree) === name));
const pointerWrite = one(node => ts.isTryStatement(node)
  && node.getText(indexTree).includes('writeFileSync(')
  && node.getText(indexTree).includes('bridgePointerPath'));
const pointerPublished = statements.find(node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(item => item.name.getText(indexTree) === 'bridgePointerPublished'));
const ready = declaration('ready');
const dispatch = declaration('dispatchCommand');
const advice = one(node => ts.isExpressionStatement(node)
  && node.getText(indexTree).startsWith("console.log('[Bridge] Encrypted endpoint ready. Run ftown security invite"));
const timer = one(node => ts.isExpressionStatement(node) && node.getText(indexTree).startsWith('setTimeout(')
  && node.getText(indexTree).includes('ready = true;'));
const cliSource = readFileSync(new URL('./cli-client.ts', import.meta.url), 'utf8');
const cliTree = ts.createSourceFile('cli-client.ts', cliSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const command = cliTree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'securityCommand');
assert.ok(command);

/** Execute the real composition-root gate/timer and CLI against inert dependencies.
 * No native process, listener, database, credentials or network request is created. */
async function startup(pointerFails = false): Promise<{
  before: { response: { success: boolean; error?: string } };
  after: { response: { success: boolean } };
  adviceResults: { ok: boolean; error?: string }[];
  timerMs: number;
  handled: string[];
  pointerWarnings: string[];
}> {
  const adviceWithinTimer = advice.getStart(indexTree) >= timer.getStart(indexTree)
    && advice.end <= timer.end;
  const harness = `
    let callback: (() => void) | undefined;
    let timerMs = 0;
    const advicePromises: Promise<{ok: boolean; error?: string}>[] = [];
    const handled: string[] = [];
    const pointerWarnings: string[] = [];
    const bridgeStateDir = '/inert';
    const bridgePointerPath = '/inert/bridge.json';
    const hookPort = 1234;
    const opts = { apiUrl: 'https://invalid.example' };
    const apiToken = 'inert';
    const dataDir = '/inert/data';
    const auth = { ownerId: 'inert' };
    const homedir = () => '/inert';
    const join = (...segments: string[]) => segments.join('/');
    const mkdirSync = () => {};
    const writeFileSync = () => { if (${pointerFails}) throw new Error('inert pointer write failure'); };
    ${pointerPublished?.getText(indexTree) ?? ''}
    const bridgeId = 'isolated-bridge';
    const security = { revalidate: async () => {} };
    const sessionController = {};
    const attentionStore = {};
    const publishRouter = { handleCommand() {} };
    const resurrection = { resurrectSessions: async () => {} };
    const applicationJson = (value: unknown) => value;
    const randomUUID = () => 'isolated-command';
    const createCommandHandler = (deps: { publishCommandResponse: (response: unknown) => Promise<void> }) => async (data: { type: string }) => {
      handled.push(data.type);
      await deps.publishCommandResponse({ requestId: 'isolated-command', success: true, data: { invitation: 'inert' } });
    };
    const setTimeout = (next: () => void, milliseconds: number) => { callback = next; timerMs = milliseconds; };
    ${ready.getText(indexTree)}
    ${dispatch.getText(indexTree)}
    const messageFor = (application: unknown) => ({ envelope: { messageId: 'isolated-command' }, application, principal: {} });
    const localApplication = async (_pointer: unknown, application: unknown) => dispatchCommand(messageFor(application) as never);
    ${command.getText(cliTree).replace(/^export\s+/, '')}
    const console = {
      log(message: string) {
        if (message.includes('Run ftown security invite')) {
          advicePromises.push(securityCommand({ bridgeId } as never, 'security_invite')
            .then(() => ({ok: true}), (error: Error) => ({ok: false, error: error.message})));
        }
      },
      error(message: string) { pointerWarnings.push(message); },
    };
    ${pointerWrite.getText(indexTree)}
    const probe = { type: 'application', route: { kind: 'command', command: 'security_invite', requestId: 'isolated-command', sessionId: null }, data: { type: 'security_invite' }, mcp: null };
    const before = await dispatchCommand(messageFor(probe) as never);
    ${adviceWithinTimer ? '' : advice.getText(indexTree)}
    ${timer.getText(indexTree)}
    callback!();
    const adviceResults = await Promise.all(advicePromises);
    const after = await dispatchCommand(messageFor(probe) as never);
    return { before, after, adviceResults, timerMs, handled, pointerWarnings };
  `;
  const js = ts.transpileModule(harness, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (source: string) => () => Promise<Awaited<ReturnType<typeof startup>>>;
  return new AsyncFunction(js)();
}

test('invite advice is emitted only when its actual encrypted CLI command can dispatch', async () => {
  const result = await startup();
  assert.deepEqual(result.adviceResults, [{ ok: true }], 'The advised invite must succeed at the advertised readiness milestone');
});

test('startup keeps its command gate closed until the existing readiness timer', async () => {
  const result = await startup();
  assert.equal(result.timerMs, 2000);
  assert.equal(result.before.response.success, false);
  assert.equal(result.before.response.error, 'bridge_offline');
  assert.equal(result.after.response.success, true);
  assert.ok(result.handled.every(type => type === 'security_invite'));
});


test('failed pointer publication does not advertise the local invitation command', async () => {
  const result = await startup(true);
  assert.deepEqual(result.adviceResults, [], 'An invitation must not be advertised without a usable current pointer');
  assert.deepEqual(result.pointerWarnings, ['[Bridge] Failed to write bridge pointer:']);
  assert.equal(result.after.response.success, true, 'Pointer failure must not alter the command gate itself');
});
