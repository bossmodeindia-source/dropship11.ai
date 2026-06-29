import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';
const frontendRoot = dirname(fileURLToPath(import.meta.url));

/**
 * next.config.mjs — V64
 * FIX: Converted from .ts (unsupported in Next.js 14.2) to .mjs
 * FIX: Added Content-Security-Policy header.
 * FIX: CSP allows https://telegram.org for Telegram Login Widget.
 */

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  outputFileTracingRoot: frontendRoot,

  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${apiUrl}/api/:path*`,
      },
    ];
  },

  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options',        value: 'DENY' },
          { key: 'X-Content-Type-Options',  value: 'nosniff' },
          { key: 'Referrer-Policy',         value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy',      value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default config;
