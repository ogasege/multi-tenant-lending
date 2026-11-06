/** WCAG 2.2 relative luminance and contrast helpers for lender colours. */

export type Rgb = [number, number, number];

export function parseHex(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m?.[1]) throw new RangeError(`Not a #RRGGBB colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

export function luminance(hex: string): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = parseHex(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Mixes `hex` towards `target` by `amount` (0–1). */
export function mix(hex: string, target: string, amount: number): string {
  const a = parseHex(hex);
  const b = parseHex(target);
  return toHex(a.map((c, i) => c + ((b[i] ?? c) - c) * amount) as Rgb);
}

export const WHITE = '#FFFFFF';
export const INK = '#111827';
export const AA_TEXT = 4.5;

export interface OnColour {
  /** The colour to fill with (possibly darkened from the lender's choice). */
  fill: string;
  /** Text colour to put on it. */
  text: string;
  ratio: number;
  /** True when the lender's colour had to be adjusted to reach AA. */
  adjusted: boolean;
}

/**
 * Picks white or ink text for a fill, whichever contrasts more. If neither reaches AA
 * (4.5:1), darkens the fill in small steps until white text does.
 */
export function onColour(fill: string, minRatio = AA_TEXT): OnColour {
  const best = (f: string) =>
    contrastRatio(f, WHITE) >= contrastRatio(f, INK)
      ? { text: WHITE, ratio: contrastRatio(f, WHITE) }
      : { text: INK, ratio: contrastRatio(f, INK) };
  const first = best(fill);
  if (first.ratio >= minRatio) return { fill: fill.toUpperCase(), ...first, adjusted: false };
  for (let step = 1; step <= 20; step++) {
    const darker = mix(fill, '#000000', step * 0.05);
    const ratio = contrastRatio(darker, WHITE);
    if (ratio >= minRatio) return { fill: darker, text: WHITE, ratio, adjusted: true };
  }
  return { fill: INK, text: WHITE, ratio: contrastRatio(INK, WHITE), adjusted: true };
}

/** A version of `colour` usable as text on a white background (≥ 4.5:1). */
export function textOnWhite(colour: string, minRatio = AA_TEXT): string {
  if (contrastRatio(colour, WHITE) >= minRatio) return colour.toUpperCase();
  for (let step = 1; step <= 20; step++) {
    const darker = mix(colour, '#000000', step * 0.05);
    if (contrastRatio(darker, WHITE) >= minRatio) return darker;
  }
  return INK;
}
