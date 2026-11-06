import type { TenantUser } from '../../../common/auth/decorators';
import type { Tx } from '../../../common/database/database.tokens';
import { NotFoundError } from '../../../common/errors/app-error';

/**
 * Object-level authorisation (OWASP API1): the customer id a CUSTOMER principal is confined
 * to, or `undefined` for staff (who see every record of their tenant; RLS bounds the tenant).
 * A customer user without a customer profile cannot own anything (404).
 */
export async function ownCustomerScope(tx: Tx, principal: TenantUser): Promise<string | undefined> {
  if (principal.role !== 'CUSTOMER') return undefined;
  const row = await tx
    .selectFrom('customers')
    .select('id')
    .where('user_id', '=', principal.id)
    .executeTakeFirst();
  if (!row) throw new NotFoundError('Customer');
  return row.id;
}
