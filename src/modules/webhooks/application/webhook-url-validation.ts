import { BusinessRuleError } from '../../../common/errors/app-error';
import { ErrorCode } from '../../../common/errors/error-codes';
import { UnsafeWebhookTargetError } from '../domain/target-policy';
import type { WebhookTargetGuard } from '../infrastructure/webhook-target-guard';

/**
 * Checks a URL a tenant wants to register; maps an SSRF refusal to 422 UNSAFE_WEBHOOK_URL.
 * The detail names the rule that failed but never the addresses the host resolved to, so
 * the endpoint cannot be used as an internal DNS oracle. Returns the normalised URL.
 */
export async function assertSafeWebhookUrl(
  guard: WebhookTargetGuard,
  url: string,
): Promise<string> {
  try {
    const target = await guard.check(url);
    return target.url.toString();
  } catch (err) {
    if (err instanceof UnsafeWebhookTargetError) {
      throw new BusinessRuleError(ErrorCode.UNSAFE_WEBHOOK_URL, err.message, {
        reason: err.reason,
      });
    }
    throw err;
  }
}
