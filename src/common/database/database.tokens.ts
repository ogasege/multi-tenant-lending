import type { Kysely, Transaction } from 'kysely';

import type { Database } from './schema';

/** Kysely bound to `lending_app` (RLS enforced). The only DB handle the API process has. */
export const APP_DB = Symbol('APP_DB');
/** Kysely bound to `lending_worker` (cross-tenant via `worker_all` policy). Worker process only. */
export const WORKER_DB = Symbol('WORKER_DB');

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;
