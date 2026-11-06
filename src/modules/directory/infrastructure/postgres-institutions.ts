import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { TransactionRunner } from '../../../common/database/transaction-runner';
import type { InstitutionLookup } from '../application/directory-projector';
import type {
  InstitutionSnapshot,
  InstitutionSnapshots,
} from '../application/project-pending-institutions';
import type { DirectoryStatus } from '../domain/directory-entry';

interface SnapshotRow {
  id: string;
  slug: string;
  status: DirectoryStatus;
  version: string;
}

/**
 * Reads this cell's institutions (the directory's source of truth) in platform scope.
 * Intended for the worker / reconciliation, which run outside any HTTP request. The version
 * is computed in SQL so it keeps Postgres' microsecond precision.
 */
@Injectable()
export class PostgresInstitutions implements InstitutionLookup, InstitutionSnapshots {
  constructor(private readonly runner: TransactionRunner) {}

  async slugOf(institutionId: string): Promise<string | undefined> {
    const row = await this.runner.asPlatformAdmin((tx) =>
      tx
        .selectFrom('institutions')
        .select('slug')
        .where('id', '=', institutionId)
        .executeTakeFirst(),
    );
    return row?.slug;
  }

  async page(afterSlug: string | undefined, limit: number): Promise<InstitutionSnapshot[]> {
    const { rows } = await this.runner.asPlatformAdmin((tx) =>
      sql<SnapshotRow>`
        SELECT id, slug, status,
               ((extract(epoch FROM updated_at) * 1000000)::bigint)::text AS version
          FROM institutions
         WHERE ${afterSlug ?? null}::text IS NULL OR slug > ${afterSlug ?? null}
         ORDER BY slug
         LIMIT ${limit}`.execute(tx),
    );
    return rows.map((r) => ({
      institutionId: r.id,
      slug: r.slug,
      status: r.status,
      version: Number(r.version),
    }));
  }
}
