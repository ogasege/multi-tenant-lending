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
  function reporter(current: DirectoryEntry | undefined) {
    const lookup = {
      invalidate: vi.fn(() => Promise.resolve()),
      find: vi.fn(() => Promise.resolve(current)),
    };
    const config = { CELL_REGION: 'af-south-1' } as Env;
    return {
      lookup,
      reporter: new ProjectionConflictReporter(lookup as unknown as DirectoryLookup, config),
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('re-reads the entry past the cache and logs a conflict with the context', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { lookup, reporter: r } = reporter(entry({ institutionId: 'inst-2' }));

    await r.reportIfConflicting('eko-medicredit', 'inst-1', { eventId: 'evt-1' });

    expect(lookup.invalidate).toHaveBeenCalledWith('eko-medicredit');
    expect(warn).toHaveBeenCalledExactlyOnceWith({
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

  it('stays quiet when the row is ours', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await reporter(entry()).reporter.reportIfConflicting('eko-medicredit', 'inst-1');
    expect(warn).not.toHaveBeenCalled();
  });
});
