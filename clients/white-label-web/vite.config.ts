/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

import { parseCellOrigins } from './src/api/cellConfig.ts';

/**
 * Local cells (see the repo's docker-compose.yml): the Lagos cell on :3000 and the
 * EU cell (profile `two-cells`) on :3001. The dev server proxies each allow-listed cell
 * (`VITE_CELL_ORIGINS`, same list the client enforces) under `/cell/{region}`: no CORS
 * preflight per call, and the client works whatever the API's CORS allow-list says.
 * Production builds call the allow-listed https:// origins directly.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const cells = parseCellOrigins(env.VITE_CELL_ORIGINS, { production: false, proxy: true });
  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: Object.fromEntries(
        Object.entries(cells.origins).map(([region, target]) => [
          `/cell/${region}`,
          {
            target,
            changeOrigin: true,
            rewrite: (path: string) => path.slice(`/cell/${region}`.length),
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
  };
});
