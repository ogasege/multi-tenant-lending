import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Three test projects (test pyramid):
 *  - unit: pure logic, co-located *.spec.ts, no I/O — milliseconds.
 *  - db:   database guarantees (RLS, ledger, audit) on a dedicated Postgres per suite.
 *  - e2e:  HTTP journeys through the real AppModule against Postgres + Redis + LocalStack,
 *          started once per run by test/setup/global-setup.ts.
 * SWC is used because esbuild does not emit decorator metadata, which NestJS DI needs.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
  test: {
    globals: true,
    root: './',
    // Coverage gate (CI fails below these). Highest bar on the money-critical pure domain.
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/main.ts', 'src/worker.ts', 'src/**/index.ts'],
      thresholds: {
        lines: 80,
        branches: 75,
        functions: 80,
        statements: 80,
        'src/modules/lending/domain/**': { lines: 95, branches: 90, functions: 95, statements: 95 },
      },
    },
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['src/**/*.spec.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'db',
          include: ['test/integration/**/*.spec.ts'],
          testTimeout: 60_000,
          hookTimeout: 240_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.spec.ts'],
          globalSetup: ['test/setup/global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 240_000,
          // One app instance per file; files share the containers but not state.
          fileParallelism: false,
        },
      },
    ],
  },
});
