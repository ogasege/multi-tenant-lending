import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';

import type {
  ReserveResult,
  SlugReservation,
  TenantDirectory,
  UpsertResult,
} from '../application/tenant-directory.port';
import {
  type CellEndpoint,
  type DirectoryEntry,
  DIRECTORY_STATUSES,
  type DirectoryStatus,
} from '../domain/directory-entry';

const PENDING = 'PENDING';

/**
 * Cell endpoints share the table with tenants (single-table design) under a key that can
 * never be a slug (slugs are `[a-z0-9-]`), so no extra table or index is needed.
 */
const cellKey = (region: string): string => `@cell:${region}`;

/**
 * `TenantDirectory` on a DynamoDB (global) table, pk `slug`. Writes are conditional on
 * ownership (home region + institution id) and `version`, which makes the projection
 * idempotent, safe against reordering, and unable to hijack a slug homed elsewhere.
 *
 * Global uniqueness of slugs: registration first reserves the slug (`PENDING` row) with a
 * conditional put. Conditions are evaluated against the local regional replica; with
 * (eventually consistent) global tables, two cells registering the SAME slug within the
 * replication lag (typically < 1 s) could both succeed and the later write wins. The
 * projector's ownership condition then stops the loser from overwriting the winner, and the
 * reconciler surfaces the conflict (its row stays `stale`). Multi-region strong consistency
 * (MRSC) global tables would close that window.
 */
export class DynamoDbTenantDirectory implements TenantDirectory {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async get(slug: string): Promise<DirectoryEntry | undefined> {
    const { Item } = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { slug } }),
    );
    return Item ? toEntry(Item) : undefined;
  }

  async upsert(entry: DirectoryEntry): Promise<UpsertResult> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...entry, kind: 'TENANT' },
          ConditionExpression:
            'attribute_not_exists(slug) OR ' +
            '(homeRegion = :region AND institutionId = :id AND #version < :version)',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: {
            ':version': entry.version,
            ':region': entry.homeRegion,
            ':id': entry.institutionId,
          },
        }),
      );
      return 'applied';
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return 'stale';
      throw err;
    }
  }

  async reserve(reservation: SlugReservation): Promise<ReserveResult> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            ...reservation,
            kind: 'TENANT',
            status: PENDING,
            version: 0,
            updatedAt: new Date().toISOString(),
          },
          ConditionExpression:
            'attribute_not_exists(slug) OR (homeRegion = :region AND #status = :pending)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':region': reservation.homeRegion, ':pending': PENDING },
        }),
      );
      return 'reserved';
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return 'taken';
      throw err;
    }
  }

  async release(slug: string, institutionId: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { slug },
          ConditionExpression: 'institutionId = :id AND #status = :pending',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':id': institutionId, ':pending': PENDING },
        }),
      );
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
    }
  }

  async putCell(cell: CellEndpoint): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          slug: cellKey(cell.region),
          kind: 'CELL',
          region: cell.region,
          apiBaseUrl: cell.apiBaseUrl,
          updatedAt: new Date().toISOString(),
        },
      }),
    );
  }
}

function toEntry(item: Record<string, unknown>): DirectoryEntry | undefined {
  const { slug, institutionId, homeRegion, apiBaseUrl, status, version, updatedAt } = item;
  if (
    typeof slug !== 'string' ||
    typeof institutionId !== 'string' ||
    typeof homeRegion !== 'string' ||
    typeof apiBaseUrl !== 'string' ||
    typeof status !== 'string' ||
    !(DIRECTORY_STATUSES as readonly string[]).includes(status) ||
    typeof version !== 'number'
  ) {
    return undefined;
  }
  return {
    slug,
    institutionId,
    homeRegion,
    apiBaseUrl,
    status: status as DirectoryStatus,
    version,
    updatedAt: typeof updatedAt === 'string' ? updatedAt : '',
  };
}
