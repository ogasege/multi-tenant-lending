import { Injectable } from '@nestjs/common';

import { TransactionRunner } from '../../../common/database/transaction-runner';
import {
  afterCursor,
  cursorTimestamp,
  decodeCursor,
  DEFAULT_PAGE_LIMIT,
  type Page,
  type PageQueryDto,
  toPage,
} from '../../../common/http/pagination';

import { InstitutionDto } from './institution.dto';

/** Keyset-paginated list of all institutions, newest first (platform scope). */
@Injectable()
export class ListInstitutions {
  constructor(private readonly runner: TransactionRunner) {}

  execute(query: PageQueryDto): Promise<Page<InstitutionDto>> {
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
    const after = decodeCursor(query.cursor);
    return this.runner.asPlatformAdmin(async (tx) => {
      let q = tx
        .selectFrom('institutions')
        .selectAll()
        .select(cursorTimestamp().as('cursor_ts'))
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1);
      if (after) q = q.where(afterCursor(after));
      return toPage(await q.execute(), limit, (row) => InstitutionDto.from(row));
    });
  }
}
