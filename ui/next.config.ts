import type { NextConfig } from "next";
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Next inlines config.env in both bundles and route handlers at build time.
const candidate = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.FTOWN_BUILD_ID;
const buildId = candidate && /^[A-Za-z0-9._-]{1,100}$/.test(candidate) ? candidate : randomUUID();

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  env: { FTOWN_UI_BUILD_ID: buildId },
  webpack(config) {
    // NodeNext shared sources name their emitted .js modules; Next bundles the
    // original TypeScript rather than the bridge's generated output.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
      '.cjs': ['.cts', '.cjs'],
    };
    config.resolve.alias['@hpke/core'] = path.join(path.dirname(require.resolve('@hpke/core/package.json')), 'esm/mod.js');
    config.resolve.alias['@hpke/common'] = path.join(path.dirname(require.resolve('@hpke/common/package.json')), 'esm/mod.js');
    // Shared bridge schemas must resolve from this independently installed app.
    config.resolve.alias['zod$'] = path.join(path.dirname(require.resolve('zod/package.json')), 'index.js');
    return config;
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;

