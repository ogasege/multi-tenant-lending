/* Operator CLI: bootstraps a platform administrator (no HTTP path can create one). */
import 'reflect-metadata';

import { parseArgs } from 'node:util';

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ClsModule } from 'nestjs-cls';

import { PasswordService } from '../../../common/auth/password.service';
import { DatabaseModule } from '../../../common/database/database.module';
import { ConfigModule } from '../../../config/config.module';
import { CreatePlatformAdmin } from '../admins/create-platform-admin.use-case';

@Module({
  imports: [ConfigModule, ClsModule.forRoot({ global: true }), DatabaseModule],
  providers: [PasswordService, CreatePlatformAdmin],
})
class CreatePlatformAdminCliModule {}

const USAGE =
  'Usage: PLATFORM_ADMIN_PASSWORD=... node dist/modules/platform/cli/create-platform-admin.js ' +
  '--email <email> --name "<full name>"';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { email: { type: 'string' }, name: { type: 'string' } },
    strict: true,
  });
  // The password comes from the environment, never argv (argv is visible in `ps` and history).
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  if (!values.email || !values.name || !password) throw new Error(USAGE);

  const app = await NestFactory.createApplicationContext(CreatePlatformAdminCliModule, {
    logger: ['error'],
  });
  try {
    const admin = await app
      .get(CreatePlatformAdmin)
      .execute({ email: values.email, fullName: values.name, password });
    process.stdout.write(`[platform] created platform admin ${admin.email} (${admin.id})\n`);
  } finally {
    await app.close();
  }
}

/* istanbul ignore next -- CLI entrypoint */
if (require.main === module) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `[platform] FAILED: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
