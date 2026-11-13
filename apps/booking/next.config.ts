import path from 'node:path';
import type { NextConfig } from 'next';

const apiUrl = (process.env.API_INTERNAL_URL ?? 'http://localhost:4000').replace(/\/$/, '');

const config: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  // A self-contained server bundle for container images.
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
  poweredByHeader: false,
  reactStrictMode: true,
  // Do not write a generated AGENTS.md into the project.
  agentRules: false,
  // Only the API's public routes are reachable through the booking site. Staff
  // routes are not proxied here, so this origin can never carry a staff session.
  async rewrites() {
    return [{ source: '/api/public/:path*', destination: `${apiUrl}/public/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // A guest's booking link is a key to the booking: it must not travel
          // to the payment page or anywhere else as a referrer.
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
      {
        // Pages opened with a guest link are personal: never cached, never indexed.
        source: '/booking/:path*',
        headers: [
          { key: 'Cache-Control', value: 'private, no-store' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
    ];
  },
};

export default config;
