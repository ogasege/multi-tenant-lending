import { Injectable } from '@nestjs/common';

import { ROLE_PERMISSIONS } from '../../common/auth/permissions';
import type { Principal } from '../../common/context/request-context';
import { TransactionRunner } from '../../common/database/transaction-runner';
import { UnauthenticatedError } from '../../common/errors/app-error';

import type { MeView } from './me.dto';

/**
 * Who the caller is. Platform admins get only their id; tenant users get their own profile,
 * the permissions of their role and the display identity of their institution.
 *
 * Reads run in the caller's tenant-pinned transaction (RLS), so only the caller's own user
 * row and institution are visible. A token whose user row no longer exists answers 401.
 */
@Injectable()
export class GetMe {
  constructor(private readonly runner: TransactionRunner) {}

  async execute(principal: Principal): Promise<MeView> {
    if (principal.kind === 'PLATFORM_ADMIN') {
      return { kind: 'PLATFORM_ADMIN', id: principal.id };
    }
    const row = await this.runner.run((tx) =>
      tx
        .selectFrom('users')
        .innerJoin('institutions', 'institutions.id', 'users.tenant_id')
        .innerJoin('institution_branding', 'institution_branding.tenant_id', 'users.tenant_id')
        .select([
          'users.id',
          'users.full_name',
          'users.email',
          'users.role',
          'institutions.slug',
          'institution_branding.display_name',
        ])
        .where('users.id', '=', principal.id)
        .executeTakeFirst(),
    );
    if (!row) throw new UnauthenticatedError();
    return {
      kind: 'USER',
      id: row.id,
      fullName: row.full_name,
      email: row.email,
      // The role as stored: a role change also revokes older tokens (AccessRevocations).
      role: row.role,
      permissions: [...ROLE_PERMISSIONS[row.role]],
      institution: { slug: row.slug, displayName: row.display_name },
    };
  }
}
