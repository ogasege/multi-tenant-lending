/*
 * OpenAPI export (`npm run openapi:export`) and staleness check (`npm run openapi:check`).
 *
 * Builds the document from the REAL AppModule in Nest's preview mode: the module graph and
 * controller metadata are resolved but no provider is instantiated, so nothing connects to
 * Postgres, Redis or AWS and no environment is needed. The result is written, pretty-printed
 * and deterministic, to openapi/openapi.json (tracked in git). `--check` exits 1 when the
 * committed file differs from what the code produces (CI gate).
 */
import 'reflect-metadata';

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { OpenAPIObject } from '@nestjs/swagger';

import { AppModule } from '../app.module';
import { API_VERSIONING, buildOpenApi } from '../app.setup';
import { WebhooksModule } from '../modules/webhooks/webhooks.module';

export const OPENAPI_PATH = path.resolve(__dirname, '../../openapi/openapi.json');

/**
 * AppModule plus feature modules whose HTTP API is part of the contract. Nest de-duplicates
 * modules, so listing one that AppModule also imports is harmless.
 */
@Module({ imports: [AppModule, WebhooksModule] })
class OpenApiModule {}

export async function buildDocument(): Promise<OpenAPIObject> {
  const app = await NestFactory.create(OpenApiModule, {
    preview: true,
    logger: false,
    abortOnError: false,
  });
  try {
    app.enableVersioning(API_VERSIONING);
    return buildOpenApi(app);
  } finally {
    await app.close();
  }
}

export function serialise(doc: OpenAPIObject): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

async function main(argv: string[]): Promise<void> {
  const rendered = serialise(await buildDocument());
  if (argv.includes('--check')) {
    const committed = await readFile(OPENAPI_PATH, 'utf8').catch(() => '');
    if (committed !== rendered) {
      process.stderr.write(
        `[openapi] ${path.relative(process.cwd(), OPENAPI_PATH)} is stale: run \`npm run openapi:export\` and commit it\n`,
      );
      process.exit(1);
    }
    process.stdout.write('[openapi] up to date\n');
    return;
  }
  await mkdir(path.dirname(OPENAPI_PATH), { recursive: true });
  await writeFile(OPENAPI_PATH, rendered);
  process.stdout.write(`[openapi] wrote ${path.relative(process.cwd(), OPENAPI_PATH)}\n`);
}

/* istanbul ignore next -- CLI entrypoint */
if (require.main === module) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`[openapi] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
