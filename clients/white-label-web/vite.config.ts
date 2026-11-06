/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Local cells (see the repo's docker-compose.yml): the Lagos cell on :3000 and the
 * EU cell (profile `two-cells`) on :3001. The dev server proxies each one under a
 * same-origin prefix: no CORS preflight per call, and the client works whatever the API's
 * CORS allow-list says. Production builds call the cells directly (`VITE_CELL_MAP`).
 */
const CELLS: Record<string, string> = {
  '/cell/af-south-1': process.env.API_AF_URL ?? 'http://localhost:3000',
  '/cell/eu-west-3': process.env.API_EU_URL ?? 'http://localhost:3001',
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: Object.fromEntries(
      Object.entries(CELLS).map(([prefix, target]) => [
        prefix,
        {
          target,
          changeOrigin: true,
          rewrite: (path: string) => path.slice(prefix.length),
        },
      ]),
    ),
  },
  preview: { port: 4173 },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    restoreMocks: true,
  },
});
