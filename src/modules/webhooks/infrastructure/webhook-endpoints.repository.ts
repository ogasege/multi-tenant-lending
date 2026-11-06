import { Injectable } from '@nestjs/common';

import type { Tx } from '../../../common/database/database.tokens';
import type { Row } from '../../../common/database/schema';
import { afterCursor, type CursorPosition, cursorTimestamp } from '../../../common/http/pagination';
import type { WebhookEndpointStatus, WebhookEndpointView } from '../domain/webhook-endpoint';

/** Every column except the secret ciphertext, which only the dispatcher ever reads. */
const PUBLIC_COLUMNS = ['id', 'url', 'event_types', 'status', 'created_at', 'updated_at'] as const;

type PublicRow = Pick<Row<'webhook_endpoints'>, (typeof PUBLIC_COLUMNS)[number]>;

export function toEndpointView(row: PublicRow): WebhookEndpointView {
  return {
    id: row.id,
    url: row.url,
    eventTypes: row.event_types,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Persistence for `webhook_endpoints`. Every method takes the caller's tenant transaction:
 * RLS scopes the rows, so another tenant's endpoint is simply not found (404).
 */
@Injectable()
export class WebhookEndpointsRepository {
  async insert(
    tx: Tx,
    values: {
      id: string;
      tenantId: string;
      url: string;
      eventTypes: string[];
      secretCiphertext: string;
    },
  ): Promise<PublicRow> {
    return tx
      .insertInto('webhook_endpoints')
      .values({
        id: values.id,
        tenant_id: values.tenantId,
        url: values.url,
        event_types: values.eventTypes,
        secret_ciphertext: values.secretCiphertext,
      })
      .returning(PUBLIC_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  async countActive(tx: Tx): Promise<number> {
    const row = await tx
      .selectFrom('webhook_endpoints')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('status', '=', 'ACTIVE')
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  findForUpdate(tx: Tx, id: string): Promise<PublicRow | undefined> {
    return tx
      .selectFrom('webhook_endpoints')
      .select(PUBLIC_COLUMNS)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
  }

  list(
    tx: Tx,
    opts: { limit: number; after?: CursorPosition; status?: WebhookEndpointStatus },
  ): Promise<(PublicRow & { cursor_ts: string })[]> {
    let q = tx
      .selectFrom('webhook_endpoints')
      .select(PUBLIC_COLUMNS)
      .select(cursorTimestamp().as('cursor_ts'))
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(opts.limit + 1);
    if (opts.status) q = q.where('status', '=', opts.status);
    if (opts.after) q = q.where(afterCursor(opts.after));
    return q.execute();
  }

  setStatus(tx: Tx, id: string, status: WebhookEndpointStatus): Promise<PublicRow> {
    return tx
      .updateTable('webhook_endpoints')
      .set({ status })
      .where('id', '=', id)
      .returning(PUBLIC_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  setSecret(tx: Tx, id: string, secretCiphertext: string): Promise<PublicRow> {
    return tx
      .updateTable('webhook_endpoints')
      .set({ secret_ciphertext: secretCiphertext })
      .where('id', '=', id)
      .returning(PUBLIC_COLUMNS)
      .executeTakeFirstOrThrow();
  }
}
