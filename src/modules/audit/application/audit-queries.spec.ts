import { decodeIdCursor, encodeIdCursor } from './audit-queries.use-case';

describe('audit id cursor', () => {
  it('round-trips an id', () => {
    expect(decodeIdCursor(encodeIdCursor(42n))).toBe(42n);
  });

  it.each([
    undefined,
    '',
    Buffer.from('0').toString('base64url'),
    Buffer.from('x1').toString('base64url'),
  ])('ignores invalid cursor %s', (cursor) => {
    expect(decodeIdCursor(cursor)).toBeUndefined();
  });
});
