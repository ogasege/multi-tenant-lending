import { Injectable } from '@nestjs/common';

import type { TenantUser } from '../../common/auth/decorators';
import { TransactionRunner } from '../../common/database/transaction-runner';
import { ForbiddenError, NotFoundError } from '../../common/errors/app-error';
import {
  afterCursor,
  cursorTimestamp,
  decodeCursor,
  DEFAULT_PAGE_LIMIT,
  type Page,
  type PageQueryDto,
  toPage,
} from '../../common/http/pagination';

import { CustomerDto } from './customer.dto';

/** The signed-in customer's own profile. Staff have no customer profile (404). */
@Injectable()
export class GetMyCustomer {
  constructor(private readonly runner: TransactionRunner) {}

  execute(principal: TenantUser): Promise<CustomerDto> {
    return this.runner.run(async (tx) => {
      const row = await tx
        .selectFrom('customers')
        .selectAll()
        .where('user_id', '=', principal.id)
        .executeTakeFirst();
      if (!row) throw new NotFoundError('Customer');
      return CustomerDto.from(row);
    });
  }
}

/**
 * One customer by id. Object-level authorisation (OWASP API1): staff may read any customer of
 * their institution (RLS limits the tenant); a CUSTOMER may only read their own record, and
 * anyone else's id is reported as 404 (no existence oracle).
 */
@Injectable()
export class GetCustomer {
  constructor(private readonly runner: TransactionRunner) {}

  execute(principal: TenantUser, customerId: string): Promise<CustomerDto> {
    return this.runner.run(async (tx) => {
      let q = tx.selectFrom('customers').selectAll().where('id', '=', customerId);
      if (principal.role === 'CUSTOMER') q = q.where('user_id', '=', principal.id);
      const row = await q.executeTakeFirst();
      if (!row) throw new NotFoundError('Customer', customerId);
      return CustomerDto.from(row);
    });
  }
}

/** Customer list for staff (newest first, keyset pagination). Customers get 403. */
@Injectable()
export class ListCustomers {
  constructor(private readonly runner: TransactionRunner) {}

  execute(principal: TenantUser, query: PageQueryDto): Promise<Page<CustomerDto>> {
    if (principal.role === 'CUSTOMER') throw new ForbiddenError();
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
    const after = decodeCursor(query.cursor);
    return this.runner.run(async (tx) => {
      let q = tx
        .selectFrom('customers')
        .selectAll()
        .select(cursorTimestamp().as('cursor_ts'))
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1);
      if (after) q = q.where(afterCursor(after));
      return toPage(await q.execute(), limit, (row) => CustomerDto.from(row));
    });
  }
}
