import { Injectable } from '@nestjs/common';

import { meetsPasswordPolicy, PASSWORD_POLICY_MESSAGE } from '../../../common/auth/password-policy';
import { PasswordService } from '../../../common/auth/password.service';
import { TransactionRunner } from '../../../common/database/transaction-runner';
import { ConflictError, ValidationError } from '../../../common/errors/app-error';
import { ErrorCode } from '../../../common/errors/error-codes';

export interface CreatePlatformAdminInput {
  email: string;
  fullName: string;
  password: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Bootstraps a platform administrator. Deliberately NOT exposed over HTTP: the first admin is
 * created by an operator with the CLI (`npm run platform:create-admin`), so no API path can
 * mint platform credentials.
 */
@Injectable()
export class CreatePlatformAdmin {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly passwords: PasswordService,
  ) {}

  async execute(input: CreatePlatformAdminInput): Promise<{ id: string; email: string }> {
    const email = input.email.trim().toLowerCase();
    const fullName = input.fullName.trim();
    if (!EMAIL.test(email)) throw new ValidationError('A valid email is required');
    if (!fullName) throw new ValidationError('A name is required');
    if (!meetsPasswordPolicy(input.password)) throw new ValidationError(PASSWORD_POLICY_MESSAGE);

    const passwordHash = await this.passwords.hash(input.password);
    return this.runner.asPlatformAuth(async (tx) => {
      const existing = await tx
        .selectFrom('platform_admins')
        .select('id')
        .where((eb) => eb(eb.fn('lower', ['email']), '=', email))
        .executeTakeFirst();
      if (existing) {
        throw new ConflictError(ErrorCode.DUPLICATE, 'A platform admin with this email exists');
      }
      return tx
        .insertInto('platform_admins')
        .values({ email, full_name: fullName, password_hash: passwordHash })
        .returning(['id', 'email'])
        .executeTakeFirstOrThrow();
    });
  }
}
