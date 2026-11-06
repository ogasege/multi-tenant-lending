import { Inject, Injectable } from '@nestjs/common';

import { APP_CONFIG } from '../../../config/config.module';
import type { Env } from '../../../config/env.schema';

import {
  type HostResolver,
  resolveSafeTarget,
  type SafeTarget,
  systemResolver,
} from './safe-target-resolver';

/** Injection token for the DNS resolver (tests substitute a fake zone). */
export const WEBHOOK_HOST_RESOLVER = Symbol('WEBHOOK_HOST_RESOLVER');

/**
 * The one SSRF guard used both when an endpoint is registered (API) and before every delivery
 * (worker). Only `WEBHOOK_ALLOW_PRIVATE_TARGETS=true` (refused in production by the env
 * schema) relaxes the private-address check, for e2e tests against a local HTTPS server.
 */
@Injectable()
export class WebhookTargetGuard {
  private readonly allowPrivate: boolean;

  constructor(
    @Inject(APP_CONFIG) config: Env,
    @Inject(WEBHOOK_HOST_RESOLVER) private readonly resolver: HostResolver,
  ) {
    this.allowPrivate = config.WEBHOOK_ALLOW_PRIVATE_TARGETS;
  }

  /** Resolves and checks the URL; throws `UnsafeWebhookTargetError` when refused. */
  check(url: string): Promise<SafeTarget> {
    return resolveSafeTarget(url, { allowPrivate: this.allowPrivate, resolver: this.resolver });
  }
}

/** Providers for a module that needs the guard (real DNS by default). */
export const WEBHOOK_TARGET_GUARD_PROVIDERS = [
  { provide: WEBHOOK_HOST_RESOLVER, useValue: systemResolver },
  WebhookTargetGuard,
];
