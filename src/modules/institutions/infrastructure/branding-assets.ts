import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';

import { S3_CLIENT, S3_PRESIGN_CLIENT } from '../../../common/aws/aws.module';
import { APP_CONFIG } from '../../../config/config.module';
import type { Env } from '../../../config/env.schema';
import {
  LOGO_MAX_BYTES,
  LOGO_UPLOAD_TTL_SECONDS,
  LOGO_URL_TTL_SECONDS,
  type LogoContentType,
} from '../domain/branding-rules';

export interface PresignedUpload {
  url: string;
  fields: Record<string, string>;
}

export interface StoredObject {
  contentType: string | undefined;
  size: number | undefined;
}

/**
 * S3 adapter for tenant brand assets. Browsers upload straight to S3 with a presigned POST
 * (the API never proxies file bytes) and read logos through short-lived presigned GET URLs,
 * so the bucket itself stays private (Block Public Access).
 *
 * Presigned URLs are signed with the browser-facing client ({@link S3_PRESIGN_CLIENT},
 * `S3_PUBLIC_ENDPOINT_URL` locally); `head` talks to S3 through the server-side client.
 */
@Injectable()
export class BrandingAssets {
  private readonly bucket: string;

  constructor(
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    @Inject(S3_PRESIGN_CLIENT) private readonly presigner: S3Client,
    @Inject(APP_CONFIG) config: Env,
  ) {
    this.bucket = config.S3_BRANDING_BUCKET;
  }

  /**
   * A browser-postable upload form for exactly one object. The signed policy pins the key
   * and the Content-Type and limits the size to 1 B–1 MiB; S3 rejects anything else, so the
   * limits hold even though the API never sees the file.
   */
  presignUpload(key: string, contentType: LogoContentType): Promise<PresignedUpload> {
    return createPresignedPost(this.presigner, {
      Bucket: this.bucket,
      Key: key,
      Conditions: [
        ['content-length-range', 1, LOGO_MAX_BYTES],
        ['eq', '$Content-Type', contentType],
      ],
      Fields: { 'Content-Type': contentType },
      Expires: LOGO_UPLOAD_TTL_SECONDS,
    });
  }

  /** Short-lived download URL for a private object (signing is local; no network call). */
  presignDownload(key: string): Promise<string> {
    return getSignedUrl(this.presigner, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: LOGO_URL_TTL_SECONDS,
    });
  }

  /** Metadata of an uploaded object, or `undefined` when it does not exist. */
  async head(key: string): Promise<StoredObject | undefined> {
    try {
      const res = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { contentType: res.ContentType, size: res.ContentLength };
    } catch (err) {
      if (err instanceof S3ServiceException && err.$metadata.httpStatusCode === 404) {
        return undefined;
      }
      throw err;
    }
  }
}
