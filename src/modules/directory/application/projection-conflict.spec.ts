import { Logger } from '@nestjs/common';

import type { Env } from '../../../config/env.schema';
import type { DirectoryEntry } from '../domain/directory-entry';

import type { DirectoryLookup } from './directory-lookup';
import { projectionConflict, ProjectionConflictReporter } from './projection-conflict';

const entry = (overrides: Partial<DirectoryEntry> = {}): DirectoryEntry => ({
  slug: 'eko-medicredit',
  institutionId: 'inst-1',
  homeRegion: 'af-south-1',
  apiBaseUrl: 'https://af-south-1.api.example.com',
  status: 'ACTIVE',
  version: 1,
  updatedAt: '2026-11-06T00:00:00.000Z',
  ...overrides,
});

describe('projectionConflict', () => {
  it('treats our own row (a replay or out-of-order event) as no conflict', () => {
    expect(projectionConflict('eko-medicredit', entry(), 'inst-1', 'af-south-1')).toBeUndefined();
  });

  it('flags a stale write whose row lookups cannot see (e.g. a foreign reservation)', () => {
    expect(projectionConflict('eko-medicredit', undefined, 'inst-1', 'af-south-1')).toEqual({
      slug: 'eko-medicredit',
      institutionId: 'inst-1',
      ownerInstitutionId: null,
      ownerHomeRegion: null,
    });
  });

  it('flags a slug owned by another cell or another institution', () => {
    expect(
      projectionConflict(
        'eko-medicredit',
        entry({ homeRegion: 'eu-west-3' }),
        'inst-1',
        'af-south-1',
      ),
    ).toEqual({
      slug: 'eko-medicredit',
      institutionId: 'inst-1',
      ownerInstitutionId: 'inst-1',
      ownerHomeRegion: 'eu-west-3',
    });
    expect(
      projectionConflict(
        'eko-medicredit',
        entry({ institutionId: 'inst-2' }),
        'inst-1',
        'af-south-1',
      ),
    ).toMatchObject({ ownerInstitutionId: 'inst-2' });
  });
});

describe('ProjectionConflictReporter', () => {
  const ORIGIN = 'https://af-south-1.api.example.com';

  function reporter() {
    const lookup = {
      invalidate: vi.fn(() => Promise.resolve()),
      find: vi.fn(),
      // The real checks, reduced to the origin rule: only the configured origin is trusted.
      sanitise: vi.fn((e: DirectoryEntry | undefined) =>
        e?.apiBaseUrl === ORIGIN ? e : undefined,
      ),
    };
    const config = { CELL_REGION: 'af-south-1' } as Env;
    return {
      lookup,
      reporter: new ProjectionConflictReporter(lookup as unknown as DirectoryLookup, config),
    };
  }

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('judges the row the failed write returned and logs a conflict with the context', async () => {
    const { lookup, reporter: r } = reporter();
    const current = entry({ institutionId: 'inst-2' });

    await r.reportIfConflicting('eko-medicredit', 'inst-1', current, { eventId: 'evt-1' });

    expect(lookup.sanitise).toHaveBeenCalledWith(current);
    expect(lookup.find).not.toHaveBeenCalled();
    expect(lookup.invalidate).toHaveBeenCalledExactlyOnceWith('eko-medicredit');
    expect(Logger.prototype.warn).toHaveBeenCalledExactlyOnceWith({
      msg: 'directory.projection_conflict',
      event: 'directory.projection_conflict',
      eventId: 'evt-1',
      cellRegion: 'af-south-1',
      slug: 'eko-medicredit',
      institutionId: 'inst-1',
      ownerInstitutionId: 'inst-2',
      ownerHomeRegion: 'af-south-1',
    });
  });

  it('stays quiet and keeps the cache when the row is ours (a replay)', async () => {
    const { lookup, reporter: r } = reporter();
    await r.reportIfConflicting('eko-medicredit', 'inst-1', entry());
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
    expect(lookup.invalidate).not.toHaveBeenCalled();
    expect(lookup.find).not.toHaveBeenCalled();
  });

  it.each<[string, DirectoryEntry | undefined]>([
    ['a PENDING reservation (unreadable as an entry)', undefined],
    ['a row lookups do not trust', entry({ apiBaseUrl: 'https://evil.example.com' })],
  ])('treats %s as a conflict', async (_case, current) => {
    const { lookup, reporter: r } = reporter();
    await r.reportIfConflicting('eko-medicredit', 'inst-1', current);
    expect(lookup.invalidate).toHaveBeenCalledWith('eko-medicredit');
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ownerInstitutionId: null, ownerHomeRegion: null }),
    );
  });
});
