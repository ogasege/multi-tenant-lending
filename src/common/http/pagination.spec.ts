import { decodeCursor, encodeCursor, toPage } from './pagination';

const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

describe('cursor pagination', () => {
  const rows = [1, 2, 3].map((n) => ({
    id: id(n),
    created_at: new Date(`2026-01-0${n}T00:00:00Z`),
    cursor_ts: `2026-01-0${n}T00:00:00.00012${n}Z`,
  }));

  it('round-trips a microsecond cursor', () => {
    const pos = { createdAt: '2026-05-01T12:00:00.123456Z', id: id(1), precision: 'us' as const };
    expect(decodeCursor(encodeCursor(pos))).toEqual(pos);
  });

  it('still decodes legacy millisecond cursors', () => {
    const legacy = Buffer.from(`2026-05-01T12:00:00.123Z|${id(2)}`).toString('base64url');
    expect(decodeCursor(legacy)).toEqual({
      createdAt: '2026-05-01T12:00:00.123Z',
      id: id(2),
      precision: 'ms',
    });
  });

  it.each([
    ['missing', undefined],
    ['garbage', 'not-a-cursor'],
    ['non-UUID id', Buffer.from('v2|2026-05-01T12:00:00.123456Z|abc').toString('base64url')],
    [
      'SQL in the id',
      Buffer.from("v2|2026-05-01T12:00:00.123456Z|x' OR '1'='1").toString('base64url'),
    ],
    ['loose timestamp', Buffer.from(`v2|yesterday|${id(1)}`).toString('base64url')],
    [
      'impossible date',
      Buffer.from(`v2|2026-02-30T00:00:00.000000Z|${id(1)}`).toString('base64url'),
    ],
  ])('treats a %s cursor as the first page', (_case, cursor) => {
    expect(decodeCursor(cursor)).toBeUndefined();
  });

  it('builds the next cursor from the database-rendered microsecond timestamp', () => {
    const page = toPage(rows, 2, (r) => r.id);
    expect(page.items).toEqual([id(1), id(2)]);
    expect(decodeCursor(page.nextCursor ?? '')).toEqual({
      createdAt: '2026-01-02T00:00:00.000122Z',
      id: id(2),
      precision: 'us',
    });
    expect(toPage(rows, 3, (r) => r.id).nextCursor).toBeNull();
  });

  it('falls back to millisecond cursors for rows without cursor_ts (legacy callers)', () => {
    const legacy = rows.map(({ cursor_ts: _ignored, ...r }) => r);
    const page = toPage(legacy, 1, (r) => r.id);
    expect(decodeCursor(page.nextCursor ?? '')).toMatchObject({ precision: 'ms', id: id(1) });
  });
});
