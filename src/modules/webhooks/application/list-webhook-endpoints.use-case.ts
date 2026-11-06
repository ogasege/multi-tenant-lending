import { Injectable } from '@nestjs/common';

import { TransactionRunner } from '../../../common/database/transaction-runner';
import {
  decodeCursor,
  DEFAULT_PAGE_LIMIT,
  type Page,
  type PageQueryDto,
  toPage,
} from '../../../common/http/pagination';
import type { WebhookEndpointStatus, WebhookEndpointView } from '../domain/webhook-endpoint';
import {
  toEndpointView,
  WebhookEndpointsRepository,
} from '../infrastructure/webhook-endpoints.repository';

/** The institution's webhook endpoints, newest first. Never includes secrets. */
@Injectable()
export class ListWebhookEndpoints {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly repo: WebhookEndpointsRepository,
  ) {}

  execute(
    query: PageQueryDto & { status?: WebhookEndpointStatus },
  ): Promise<Page<WebhookEndpointView>> {
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
    return this.runner.run(async (tx) => {
      const rows = await this.repo.list(tx, {
        limit,
        after: decodeCursor(query.cursor),
        status: query.status,
      });
      return toPage(rows, limit, toEndpointView);
    });
  }
}
