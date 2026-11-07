/*
 * API-client collections (`npm run api-client:export`) and staleness check
 * (`npm run api-client:check`).
 *
 * Renders the reviewer walkthrough (`api-client/definition.ts`) to an Insomnia v5 YAML export
 * and a Postman v2.1 collection plus one Postman environment per cell, under `api-client/`.
 * `--check` exits 1 when a committed file differs from what the definition produces.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { WALKTHROUGH } from './api-client/definition';
import { renderInsomnia } from './api-client/insomnia';
import type { Walkthrough } from './api-client/model';
import { renderPostmanCollection, renderPostmanEnvironment } from './api-client/postman';

export const API_CLIENT_DIR = path.resolve(__dirname, '../../api-client');

const ENV_FILE_NAMES: Readonly<Record<string, string>> = {
  'env.lagos': 'local-lagos.postman_environment.json',
  'env.paris': 'local-paris.postman_environment.json',
};

/** File name (relative to `api-client/`) → content. */
export function renderAll(w: Walkthrough = WALKTHROUGH): Map<string, string> {
  const files = new Map<string, string>([
    ['multi-tenant-lending.insomnia.yaml', renderInsomnia(w)],
    ['multi-tenant-lending.postman_collection.json', renderPostmanCollection(w)],
  ]);
  for (const env of w.environments) {
    const name = ENV_FILE_NAMES[env.key];
    if (!name) throw new Error(`no file name for environment ${env.key}`);
    files.set(name, renderPostmanEnvironment(w, env));
  }
  return files;
}

async function main(argv: string[]): Promise<void> {
  const files = renderAll();
  if (argv.includes('--check')) {
    const stale: string[] = [];
    for (const [name, content] of files) {
      const committed = await readFile(path.join(API_CLIENT_DIR, name), 'utf8').catch(() => '');
      if (committed !== content) stale.push(name);
    }
    if (stale.length > 0) {
      process.stderr.write(
        `[api-client] stale: ${stale.join(', ')}; run \`npm run api-client:export\` and commit\n`,
      );
      process.exit(1);
    }
    process.stdout.write('[api-client] up to date\n');
    return;
  }
  await mkdir(API_CLIENT_DIR, { recursive: true });
  for (const [name, content] of files) {
    await writeFile(path.join(API_CLIENT_DIR, name), content);
    process.stdout.write(`[api-client] wrote api-client/${name}\n`);
  }
}

/* istanbul ignore next -- CLI entrypoint */
if (require.main === module) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(
      `[api-client] FAILED: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
