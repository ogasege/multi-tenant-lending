import fc from 'fast-check';

import { daysPastDue, dpdBucket } from './dpd';

describe('DPD', () => {
  it.each([
    [null, '2026-11-06', 0],
    ['2026-11-06', '2026-11-06', 0], // due today: not late yet
    ['2026-11-07', '2026-11-06', 0], // not yet due
    ['2026-11-05', '2026-11-06', 1],
    ['2026-10-07', '2026-11-06', 30],
    ['2024-02-28', '2024-03-01', 2], // leap day counted
  ])('daysPastDue(%s, %s) = %i', (due, asOf, expected) => {
    expect(daysPastDue(due, asOf)).toBe(expected);
  });

  it.each([
    [0, 'CURRENT'],
    [1, 'DPD_1_30'],
    [30, 'DPD_1_30'],
    [31, 'DPD_31_60'],
    [60, 'DPD_31_60'],
    [61, 'DPD_61_90'],
    [90, 'DPD_61_90'],
    [91, 'DPD_90_PLUS'],
    [400, 'DPD_90_PLUS'],
  ] as const)('bucket(%i) = %s', (dpd, bucket) => {
    expect(dpdBucket(dpd)).toBe(bucket);
  });

  it('property: buckets are monotone in DPD', () => {
    const order = ['CURRENT', 'DPD_1_30', 'DPD_31_60', 'DPD_61_90', 'DPD_90_PLUS'];
    fc.assert(
      fc.property(fc.nat(1000), fc.nat(1000), (a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(order.indexOf(dpdBucket(lo))).toBeLessThanOrEqual(order.indexOf(dpdBucket(hi)));
      }),
    );
  });
});
