/**
 * Pure rules for white-label branding assets and fields (no I/O).
 *
 * Logo uploads accept raster images only. SVG is deliberately excluded: an SVG is an XML
 * document that may carry `<script>`, event-handler attributes and external references, so a
 * tenant-supplied SVG opened directly (or embedded via `<object>`/`<iframe>`) executes script
 * in whatever origin serves it — stored XSS against every borrower of that white-label front
 * end. Accepting SVG safely would require server-side sanitisation; PNG/JPEG/WebP need none.
 */
export const LOGO_CONTENT_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
} as const;

export type LogoContentType = keyof typeof LOGO_CONTENT_TYPES;

/** Upper bound for a logo upload, enforced by the S3 POST policy (1 MiB). */
export const LOGO_MAX_BYTES = 1024 * 1024;

/** Lifetime of a presigned upload form (seconds). */
export const LOGO_UPLOAD_TTL_SECONDS = 5 * 60;

/** Lifetime of a presigned logo download URL (seconds). */
export const LOGO_URL_TTL_SECONDS = 60 * 60;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** All branding objects of a tenant live under this prefix (the IAM policy can match it). */
export function brandingPrefix(tenantId: string): string {
  return `tenants/${tenantId}/branding/`;
}

/** Object key of a new logo: `tenants/<tenantId>/branding/logo-<uuid>.<ext>`. */
export function logoObjectKey(
  tenantId: string,
  uploadId: string,
  contentType: LogoContentType,
): string {
  return `${brandingPrefix(tenantId)}logo-${uploadId}.${LOGO_CONTENT_TYPES[contentType]}`;
}

/**
 * True only for a key this tenant could have obtained from the upload endpoint. Matching
 * the complete shape (not just the prefix) also rules out `..` segments and other tricks
 * that would make a branding record point at another tenant's object.
 */
export function isOwnLogoObjectKey(tenantId: string, key: string): boolean {
  const prefix = brandingPrefix(tenantId);
  if (!key.startsWith(prefix)) return false;
  const exts = Object.values(LOGO_CONTENT_TYPES).join('|');
  return new RegExp(`^logo-${UUID}\\.(?:${exts})$`).test(key.slice(prefix.length));
}

export function isLogoContentType(value: string | undefined): value is LogoContentType {
  return value !== undefined && Object.hasOwn(LOGO_CONTENT_TYPES, value);
}

/** `#RRGGBB` colour. */
export const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

/**
 * BCP 47 subset used by the front ends: language (2–3 letters), optional script
 * (4 letters) and optional region (2 letters or UN M.49 digits) — `en-NG`, `fr-SN`,
 * `en-GB`, `fr-FR`, `zh-Hant-TW`, `es-419`.
 */
export const LOCALE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?$/;

/** E.164 phone number. */
export const E164_PHONE = /^\+[1-9]\d{6,14}$/;

/** Institution slug, as constrained by the `institutions.slug` CHECK. */
export function isValidSlug(slug: string): boolean {
  return slug.length >= 3 && slug.length <= 63 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}
