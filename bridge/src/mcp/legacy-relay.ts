import { FleetError, requestSchema, type BridgeRequest } from "./fleet.js";

/** Fixed loopback client for pre-MCP workers. Only base64 enters shell syntax. */
export function legacyRelayCommand(machineId: string, input: BridgeRequest, deadline: number) {
  const request = requestSchema.parse(input);
  const source = `
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { machineId, request, deadline } = ${JSON.stringify({ machineId, request, deadline })};
const mutation = request.method !== 'GET';
let sent = false;
const fail = (code, message, outcomeUnknown = false, status) => {
  process.stdout.write(JSON.stringify({ error: { code, message, outcomeUnknown, ...(status ? {status} : {}) } }));
};
(async () => {
  if (Date.now() >= deadline) return fail('timeout', 'Request expired before execution');
  const credentials = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.ftown', 'bridge.json'), 'utf8'));
  if (credentials.bridgeId !== machineId || !Number.isInteger(credentials.port) || credentials.port < 1 || credentials.port > 65535 || typeof credentials.token !== 'string' || !credentials.token)
    return fail('configuration_error', 'Local bridge identity does not match the requested computer');
  const origin = 'http://127.0.0.1:' + credentials.port;
  const url = new URL(request.path, origin);
  if (url.origin !== origin) return fail('configuration_error', 'Invalid local bridge origin');
  if (Date.now() >= deadline) return fail('timeout', 'Request expired before execution');
  sent = true;
  const response = await fetch(url, {
    method: request.method, redirect: 'error',
    headers: { authorization: 'Bearer ' + credentials.token, 'content-type': 'application/json' },
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
  });
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 400000) return fail('response_too_large', 'Request a smaller history or session page', mutation);
    chunks.push(chunk);
  }
  if (!response.ok) return fail('bridge_error', 'Local bridge rejected the request (HTTP ' + response.status + ')', mutation && response.status >= 500, response.status);
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  process.stdout.write(JSON.stringify({ data }));
})().catch(() => fail('bridge_error', 'Legacy bridge loopback request failed', sent && mutation));
`;
  const encoded = Buffer.from(source).toString("base64");
  if (encoded.length > 100000)
    throw new FleetError("request_too_large", "Request is too large for this older bridge; upgrade the bridge or shorten the input");
  return `node -e "eval(Buffer.from('${encoded}','base64').toString())"`;
}
