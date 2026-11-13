import path from 'node:path';
import type { NextConfig } from 'next';

const apiUrl = (process.env.API_INTERNAL_URL ?? 'http://localhost:4000').replace(/\/$/, '');

const config: NextConfig = {
  // Browser tests build into their own directory so they can run beside `pnpm dev`.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  // A self-contained server bundle for container images.
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
  poweredByHeader: false,
  reactStrictMode: true,
  // Do not write a generated AGENTS.md into the project.
  agentRules: false,
  // The browser talks to the API through this origin, so the session cookie
  // is same-site and no cross-origin configuration is needed.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default config;
