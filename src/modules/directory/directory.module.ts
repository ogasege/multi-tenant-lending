import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  Global,
  Inject,
  Injectable,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type OnApplicationShutdown,
  RequestMethod,
} from '@nestjs/common';

import { CELL_LOCATOR } from '../../common/auth/cell-locator';
import { APP_CONFIG } from '../../config/config.module';
import type { Env } from '../../config/env.schema';

import { DirectoryLookup } from './application/directory-lookup';
import {
  DirectoryProjector,
  INSTITUTION_LOOKUP,
  type InstitutionLookup,
} from './application/directory-projector';
import { DirectoryReconciler } from './application/directory-reconciler';
import { GetDirectoryEntry } from './application/get-directory-entry.use-case';
import { INSTITUTION_SNAPSHOTS } from './application/project-pending-institutions';
import { ProjectionConflictReporter } from './application/projection-conflict';
import { SlugReservations } from './application/slug-reservations';
import { TENANT_DIRECTORY, type TenantDirectory } from './application/tenant-directory.port';
import { parseApiBaseUrl } from './domain/directory-entry';
import { DirectoryCache } from './infrastructure/directory-cache';
import { createDirectoryDocumentClient } from './infrastructure/dynamodb';
import { DynamoDbTenantDirectory } from './infrastructure/dynamodb-tenant-directory';
import { PostgresInstitutions } from './infrastructure/postgres-institutions';
import { CellRoutingMiddleware } from './interface/http/cell-routing.middleware';
import { DirectoryController } from './interface/http/directory.controller';

const DIRECTORY_DB_CLIENT = Symbol('DIRECTORY_DB_CLIENT');

@Injectable()
class DirectoryClientLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DIRECTORY_DB_CLIENT) private readonly client: DynamoDBDocumentClient) {}

  /** Releases the client's keep-alive sockets so the process can exit cleanly. */
  onApplicationShutdown(): void {
    this.client.destroy();
  }
}

/**
 * Global control plane, per cell (SPEC §4.1): the tenant directory projection, its public
 * lookup endpoint, slug-based cell routing (307) and the `CellLocator` that enriches 421
 * Misdirected Request responses.
 *
 * Global so the auth guard (CommonModule) can resolve `CELL_LOCATOR` and the worker can
 * inject `DirectoryProjector` / `DirectoryReconciler` / `ProjectionConflictReporter`.
 */
@Global()
@Module({
  controllers: [DirectoryController],
  providers: [
    {
      provide: DIRECTORY_DB_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: Env) => createDirectoryDocumentClient(config),
    },
    {
      provide: TENANT_DIRECTORY,
      inject: [DIRECTORY_DB_CLIENT, APP_CONFIG],
      useFactory: (client: DynamoDBDocumentClient, config: Env): TenantDirectory =>
        new DynamoDbTenantDirectory(client, config.DIRECTORY_TABLE_NAME),
    },
    PostgresInstitutions,
    { provide: INSTITUTION_LOOKUP, useExisting: PostgresInstitutions },
    { provide: INSTITUTION_SNAPSHOTS, useExisting: PostgresInstitutions },
    {
      provide: DirectoryProjector,
      inject: [TENANT_DIRECTORY, APP_CONFIG, INSTITUTION_LOOKUP, DirectoryLookup],
      useFactory: (
        directory: TenantDirectory,
        config: Env,
        institutions: InstitutionLookup,
        lookup: DirectoryLookup,
      ): DirectoryProjector => {
        const insecure = config.NODE_ENV === 'test' || config.NODE_ENV === 'development';
        const apiBaseUrl = parseApiBaseUrl(config.CELL_API_BASE_URL, insecure);
        if (!apiBaseUrl) {
          throw new Error('CELL_API_BASE_URL must be a bare https:// origin (no path or query)');
        }
        return new DirectoryProjector(
          directory,
          { region: config.CELL_REGION, apiBaseUrl },
          institutions,
          (slug) => lookup.invalidate(slug),
        );
      },
    },
    DirectoryReconciler,
    ProjectionConflictReporter,
    DirectoryCache,
    DirectoryLookup,
    { provide: CELL_LOCATOR, useExisting: DirectoryLookup },
    GetDirectoryEntry,
    SlugReservations,
    DirectoryClientLifecycle,
  ],
  exports: [
    DirectoryProjector,
    DirectoryReconciler,
    ProjectionConflictReporter,
    DirectoryLookup,
    SlugReservations,
    CELL_LOCATOR,
  ],
})
export class DirectoryModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(CellRoutingMiddleware)
      .forRoutes(
        { path: 'auth/login', method: RequestMethod.POST, version: '1' },
        { path: 'institutions/:slug/*path', method: RequestMethod.ALL, version: '1' },
      );
  }
}
