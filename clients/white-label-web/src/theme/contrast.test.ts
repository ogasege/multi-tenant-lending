import { describe, expect, it } from 'vitest';

import lenders from '../../demo-brands/lenders.json';

import { contrastRatio, INK, onColour, textOnWhite, WHITE } from './contrast';

describe('contrast', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
  });

  it('puts ink text on a light primary and white on a dark one', () => {
    expect(onColour('#F2A541').text).toBe(INK);
    expect(onColour('#0B6E4F').text).toBe(WHITE);
  });

  it('darkens a primary that fails AA with both text colours', () => {
    const r = onColour('#7A7A7A');
    expect(r.adjusted).toBe(true);
    expect(r.ratio).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(r.fill, r.text)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps link colours readable on white', () => {
    expect(contrastRatio(textOnWhite('#14B8A6'), WHITE)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(lenders.lenders)('demo lender $slug passes AA on primary and secondary', (l) => {
    expect(onColour(l.primaryColor).adjusted).toBe(false);
    expect(onColour(l.secondaryColor).adjusted).toBe(false);
    expect(contrastRatio(l.primaryColor, WHITE)).toBeGreaterThanOrEqual(4.5);
  });
});
