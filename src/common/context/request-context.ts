import type { ClsStore } from 'nestjs-cls';

import type { UserRole } from '../database/schema';

/** Who is making the request. Derived ONLY from a verified access token. */
export type Principal =
  | { kind: 'PLATFORM_ADMIN'; id: string }
  | { kind: 'USER'; id: string; tenantId: string; role: UserRole };

/** Keys stored in the CLS (AsyncLocalStorage) store for the lifetime of one request/job. */
export interface RequestContextStore extends ClsStore {
  requestId: string;
  principal?: Principal;
  /** Tenant for this unit of work. Set from the JWT `tid` claim, or by a job/public route. */
  tenantId?: string;
  ip?: string;
  userAgent?: string;
}
