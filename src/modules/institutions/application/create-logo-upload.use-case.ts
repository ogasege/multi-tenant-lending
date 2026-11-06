import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import {
  LOGO_MAX_BYTES,
  LOGO_UPLOAD_TTL_SECONDS,
  type LogoContentType,
  logoObjectKey,
} from '../domain/branding-rules';
import { BrandingAssets } from '../infrastructure/branding-assets';

export interface LogoUploadView {
  url: string;
  fields: Record<string, string>;
  objectKey: string;
  expiresAt: Date;
  maxBytes: number;
}

/**
 * Issues a presigned S3 POST for a new logo. The key is generated server-side under the
 * caller's tenant prefix, so a client can neither choose nor overwrite another object. The
 * upload does not change branding; the admin then PUTs the returned `objectKey`.
 */
@Injectable()
export class CreateLogoUpload {
  constructor(private readonly assets: BrandingAssets) {}

  async execute(tenantId: string, contentType: LogoContentType): Promise<LogoUploadView> {
    const objectKey = logoObjectKey(tenantId, randomUUID(), contentType);
    const expiresAt = new Date(Date.now() + LOGO_UPLOAD_TTL_SECONDS * 1000);
    const { url, fields } = await this.assets.presignUpload(objectKey, contentType);
    return { url, fields, objectKey, expiresAt, maxBytes: LOGO_MAX_BYTES };
  }
}
