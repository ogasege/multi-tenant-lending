/**
 * Turns a lender's public branding into CSS custom properties. This is the ONLY place a
 * lender's look is decided; components read `var(--brand-…)` and never know which lender
 * they render for.
 */
import type { PublicBranding } from '../api/types';

import { contrastRatio, mix, onColour, textOnWhite, WHITE } from './contrast';

export type TokenName =
  | '--brand-primary'
  | '--brand-primary-hover'
  | '--brand-primary-soft'
  | '--brand-on-primary'
  | '--brand-primary-text'
  | '--brand-secondary'
  | '--brand-on-secondary';

export type ThemeTokens = Record<TokenName, string>;

export interface ThemeReport {
  tokens: ThemeTokens;
  primaryRatio: number;
  secondaryRatio: number;
  /** Colours the client adjusted to keep WCAG AA; shown in the Developer view. */
  adjustments: string[];
}

export function themeFromBranding(
  b: Pick<PublicBranding, 'primaryColor' | 'secondaryColor'>,
): ThemeReport {
  const primary = onColour(b.primaryColor);
  const secondary = onColour(b.secondaryColor);
  const adjustments: string[] = [];
  if (primary.adjusted) adjustments.push(`primary ${b.primaryColor} → ${primary.fill}`);
  if (secondary.adjusted) adjustments.push(`secondary ${b.secondaryColor} → ${secondary.fill}`);
  const hover =
    primary.text === WHITE
      ? mix(primary.fill, '#000000', 0.12)
      : mix(primary.fill, '#FFFFFF', 0.12);
  return {
    tokens: {
      '--brand-primary': primary.fill,
      '--brand-primary-hover': hover,
      '--brand-primary-soft': mix(primary.fill, '#FFFFFF', 0.9),
      '--brand-on-primary': primary.text,
      '--brand-primary-text': textOnWhite(primary.fill),
      '--brand-secondary': secondary.fill,
      '--brand-on-secondary': secondary.text,
    },
    primaryRatio: contrastRatio(primary.fill, primary.text),
    secondaryRatio: contrastRatio(secondary.fill, secondary.text),
    adjustments,
  };
}

/** Writes the tokens on `root` (default: <html>) and sets lang and the page title. */
export function applyBranding(
  b: PublicBranding,
  root: HTMLElement = document.documentElement,
): ThemeReport {
  const report = themeFromBranding(b);
  for (const [name, value] of Object.entries(report.tokens)) root.style.setProperty(name, value);
  root.lang = b.locale;
  root.dataset.lender = b.slug;
  document.title = b.displayName;
  return report;
}
