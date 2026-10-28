import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CENTRIFUGO_IMAGE = 'centrifugo/centrifugo:v6.10.2@sha256:34b84f823515927266ce3abfb840fd9e0acabb58805e7e896f5de731217a627d';
export const CONFIGURATIONS = {
  development: 'centrifugo/config.json', fly: 'centrifugo/config.fly.json',
  legacy: 'centrifugo/config.prod.json', e2e: 'e2e/centrifugo.config.json',
};
export const IMAGE_REFERENCES = ['centrifugo/Dockerfile.fly', 'docker-compose.yml', 'e2e/docker-compose.yml', '.github/workflows/deploy-centrifugo-fly.yml', '.github/workflows/deploy-centrifugo.yml', 'scripts/ci/validate-centrifugo.sh'];
const origins = ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002'];
const defaults = {
  allow_user_limited_channels: true, allow_publish_for_subscriber: false,
  allow_subscribe_for_client: false, allow_history_for_subscriber: true,
  presence: true, join_leave: true, force_push_join_leave: true,
  allow_presence_for_subscriber: true, history_size: 500, history_ttl: '24h', force_recovery: true,
};
function namespaces(fly) {
  const permissions = { allow_publish_for_subscriber: true, allow_subscribe_for_client: true, allow_user_limited_channels: true };
  return [
    { name: 'terminal', ...permissions, allow_history_for_subscriber: true,
      history_size: fly ? 20 : 10000, history_ttl: fly ? '5m' : '24h', force_recovery: !fly, allow_publish_for_client: true },
    { name: 'sessions', ...permissions, history_size: 0, history_ttl: '0s', force_recovery: false, allow_publish_for_client: true },
    { name: 'terminal-input', ...permissions, allow_publish_for_client: true },
    { name: 'events', ...permissions, history_size: 100, history_ttl: '1h', allow_publish_for_client: true },
    { name: 'commands', ...permissions, allow_publish_for_client: true },
    { name: 'bridges', ...permissions, presence: true, join_leave: true, force_push_join_leave: true,
      allow_presence_for_subscriber: true, allow_publish_for_client: true },
  ];
}

// Frozen external behavior, including omitted fields. Exact comparison rejects
// unknown/misspelled v5/v6 keys as well as missing security/permission settings.
export function expectedConfiguration(kind) {
  assert.ok(Object.hasOwn(CONFIGURATIONS, kind), 'Unknown config kind');
  const fly = kind === 'fly', legacy = kind === 'legacy', e2e = kind === 'e2e';
  const client = {
    token: { audience: 'ftown:centrifugo', ...(!fly ? { hmac_secret_key: legacy ? '__CENTRIFUGO_TOKEN_HMAC_SECRET_KEY__' : e2e ? 'e2e-centrifugo-token-secret-0123456789abcdef' : 'your-centrifugo-token-secret-change-me' } : {}) },
    allowed_origins: fly ? ['https://ftown.ia.br'] : legacy ? ['*'] : e2e ? [...origins, 'https://localhost:8444'] : origins,
    allow_anonymous_connect_without_token: false,
    ...(fly ? { disallow_anonymous_connection_tokens: true, connection_limit: 240,
      user_connection_limit: 128, connection_rate_limit: 50 } : {}),
    channel_limit: fly ? 512 : legacy ? 4096 : 256,
    queue_max_size: fly ? 8388608 : 67108864, stale_close_delay: '30s',
    ping_interval: '10s', pong_timeout: '5s',
  };
  const config = {
    client,
    admin: legacy ? { enabled: true, password: '__CENTRIFUGO_ADMIN_PASSWORD__', secret: '__CENTRIFUGO_ADMIN_SECRET__' }
      : e2e ? { enabled: true, password: 'admin', secret: 'admin-secret' } : { enabled: false },
    http_api: fly ? { disabled: true } : { key: legacy ? '__CENTRIFUGO_API_KEY__' : e2e ? 'e2e-centrifugo-api-key-0123456789abcdef' : 'your-centrifugo-api-key-change-me' },
    channel: { without_namespace: defaults, namespaces: namespaces(fly || legacy) },
    websocket: { message_size_limit: fly ? 1048576 : 33554432, compression: true, compression_min_size: 1024 },
    log: { level: 'info' },
  };
  if (fly) Object.assign(config, {
    engine: { type: 'memory' }, health: { enabled: true },
    http_server: { address: '0.0.0.0', port: 8000, internal_address: '127.0.0.1', internal_port: '9000' },
  });
  if (e2e) config.health = { enabled: true };
  if (legacy) config.http_server = {
    address: '0.0.0.0', port: 443, internal_port: '9000', tls_autocert: {
      enabled: true, host_whitelist: 'centrifugo.webcraw.ai,wss.ftown.ia.br',
      cache_dir: '/centrifugo/autocert', http: true, http_addr: ':80',
    },
  };
  return config;
}
export function validateConfiguration(config, kind) {
  assert.deepEqual(config, expectedConfiguration(kind), `${kind}: configuration differs from the reviewed security/behavior contract`);
}
export function assertCleanCheckconfigOutput(output) {
  assert.doesNotMatch(output, /unknown|unrecognized|unsupported/i, 'Centrifugo warned about an unknown configuration option');
}
export function checkConfigurations(root = process.cwd()) {
  for (const [kind, file] of Object.entries(CONFIGURATIONS)) validateConfiguration(JSON.parse(readFileSync(resolve(root, file), 'utf8')), kind);
  for (const file of IMAGE_REFERENCES) {
    assert.ok(readFileSync(resolve(root, file), 'utf8').includes(CENTRIFUGO_IMAGE), `${file}: patched image pin drifted`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkConfigurations();
  console.log(`Centrifugo configuration contract verified (${Object.keys(CONFIGURATIONS).length} configs and ${IMAGE_REFERENCES.length} image references).`);
}
