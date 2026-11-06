import { Injectable } from '@nestjs/common';

import { TransactionRunner } from '../../common/database/transaction-runner';
import {
  afterCursor,
  cursorTimestamp,
  decodeCursor,
  DEFAULT_PAGE_LIMIT,
  type Page,
  type PageQueryDto,
  toPage,
} from '../../common/http/pagination';

import { USER_COLUMNS, UserDto } from './user.dto';

/** Staff users of the caller's institution (customers are listed via /customers). */
@Injectable()
export class ListUsers {
  constructor(private readonly runner: TransactionRunner) {}

  execute(query: PageQueryDto): Promise<Page<UserDto>> {
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
    const after = decodeCursor(query.cursor);
    return this.runner.run(async (tx) => {
      let q = tx
        .selectFrom('users')
        .select(USER_COLUMNS)
        .where('role', '!=', 'CUSTOMER')
        .select(cursorTimestamp().as('cursor_ts'))
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1);
      if (after) q = q.where(afterCursor(after));
      return toPage(await q.execute(), limit, (row) => UserDto.from(row));
    });
  }
}
