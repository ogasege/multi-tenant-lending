import type { BrandingAssets } from '../infrastructure/branding-assets';
import type { BrandingRow } from '../infrastructure/institutions.repository';

/** Tenant-facing branding representation (matches `BrandingDto`). */
export interface BrandingView {
  displayName: string;
  primaryColor: string;
  secondaryColor: string;
  supportEmail: string | null;
  supportPhone: string | null;
  websiteUrl: string | null;
  locale: string;
  logoObjectKey: string | null;
  logoUrl: string | null;
  version: number;
  updatedAt: Date;
}

export async function toBrandingView(
  row: BrandingRow,
  assets: BrandingAssets,
): Promise<BrandingView> {
  return {
    displayName: row.display_name,
    primaryColor: row.primary_color,
    secondaryColor: row.secondary_color,
    supportEmail: row.support_email,
    supportPhone: row.support_phone,
    websiteUrl: row.website_url,
    locale: row.locale,
    logoObjectKey: row.logo_object_key,
    logoUrl: row.logo_object_key ? await assets.presignDownload(row.logo_object_key) : null,
    version: row.version,
    updatedAt: row.updated_at,
  };
}
