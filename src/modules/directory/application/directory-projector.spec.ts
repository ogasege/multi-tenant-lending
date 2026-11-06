import type { CellEndpoint, DirectoryEntry } from '../domain/directory-entry';

import { DirectoryProjector, type InstitutionEvent } from './directory-projector';
import { projectPendingInstitutions } from './project-pending-institutions';
import type {
  ReserveResult,
  SlugReservation,
  TenantDirectory,
  UpsertResult,
} from './tenant-directory.port';

/** In-memory directory with the same conditional-write rule as the DynamoDB adapter. */
class FakeDirectory implements TenantDirectory {
  readonly rows = new Map<string, DirectoryEntry>();
  readonly cells = new Map<string, CellEndpoint>();

  get(slug: string): Promise<DirectoryEntry | undefined> {
    return Promise.resolve(this.rows.get(slug));
  }

  upsert(entry: DirectoryEntry): Promise<UpsertResult> {
    const current = this.rows.get(entry.slug);
    const owned =
      current?.homeRegion === entry.homeRegion && current.institutionId === entry.institutionId;
    if (current && (!owned || current.version >= entry.version)) return Promise.resolve('stale');
    this.rows.set(entry.slug, entry);
    return Promise.resolve('applied');
  }

  reserve(r: SlugReservation): Promise<ReserveResult> {
    const current = this.rows.get(r.slug);
    if (current) return Promise.resolve('taken');
    this.rows.set(r.slug, { ...r, status: 'ACTIVE', version: 0, updatedAt: '' });
    return Promise.resolve('reserved');
  }

  release(slug: string): Promise<void> {
    this.rows.delete(slug);
    return Promise.resolve();
  }

  putCell(cell: CellEndpoint): Promise<void> {
    this.cells.set(cell.region, cell);
    return Promise.resolve();
  }
}

const CELL: CellEndpoint = { region: 'af-south-1', apiBaseUrl: 'https://af.api.example.com' };
const ID = '7b0c6c1e-0000-4000-8000-000000000001';

const registered = (version: number): InstitutionEvent => ({
  type: 'institution.registered',
  version,
  payload: { institutionId: ID, slug: 'acme-mfb', homeRegion: 'af-south-1' },
});
const statusChanged = (version: number, to: string): InstitutionEvent => ({
  type: 'institution.status_changed',
  version,
  payload: { institutionId: ID, from: 'ACTIVE', to },
});

describe('DirectoryProjector', () => {
  let directory: FakeDirectory;
  let invalidated: string[];
  let projector: DirectoryProjector;

  beforeEach(() => {
    directory = new FakeDirectory();
    invalidated = [];
    projector = new DirectoryProjector(
      directory,
      CELL,
      { slugOf: (id) => Promise.resolve(id === ID ? 'acme-mfb' : undefined) },
      (slug) => {
        invalidated.push(slug);
        return Promise.resolve();
      },
    );
  });

  it('projects a registration as an ACTIVE entry pointing at this cell', async () => {
    await expect(projector.project(registered(100))).resolves.toBe('applied');
    expect(directory.rows.get('acme-mfb')).toMatchObject({
      slug: 'acme-mfb',
      institutionId: ID,
      homeRegion: 'af-south-1',
      apiBaseUrl: 'https://af.api.example.com',
      status: 'ACTIVE',
      version: 100,
    });
    expect(directory.cells.get('af-south-1')).toEqual(CELL);
    expect(invalidated).toEqual(['acme-mfb']);
  });

  it('applies a newer status change, looking the slug up by institution id', async () => {
    await projector.project(registered(100));
    await expect(projector.project(statusChanged(200, 'SUSPENDED'))).resolves.toBe('applied');
    expect(directory.rows.get('acme-mfb')).toMatchObject({ status: 'SUSPENDED', version: 200 });
  });

  it('never lets an older event overwrite a newer state (out-of-order delivery)', async () => {
    await projector.project(statusChanged(300, 'SUSPENDED'));
    await expect(projector.project(registered(100))).resolves.toBe('stale');
    await expect(projector.project(statusChanged(200, 'ACTIVE'))).resolves.toBe('stale');
    expect(directory.rows.get('acme-mfb')).toMatchObject({ status: 'SUSPENDED', version: 300 });
  });

  it('never takes over a slug owned by another cell or institution', async () => {
    const foreign = {
      slug: 'acme-mfb',
      institutionId: '7b0c6c1e-0000-4000-8000-0000000000ff',
      homeRegion: 'eu-west-3',
      apiBaseUrl: 'https://eu.api.example.com',
      status: 'ACTIVE' as const,
      version: 1,
      updatedAt: '',
    };
    directory.rows.set('acme-mfb', foreign);
    await expect(projector.project(registered(999))).resolves.toBe('stale');
    expect(directory.rows.get('acme-mfb')).toBe(foreign);
  });

  it('is idempotent: a redelivered event changes nothing', async () => {
    await projector.project(registered(100));
    const before = directory.rows.get('acme-mfb');
    invalidated.length = 0;
    await expect(projector.project(registered(100))).resolves.toBe('stale');
    expect(directory.rows.get('acme-mfb')).toBe(before);
    expect(invalidated).toEqual([]);
  });

  it('converges to the latest state for every delivery order', async () => {
    const events = [registered(100), statusChanged(200, 'SUSPENDED'), statusChanged(300, 'ACTIVE')];
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    for (const order of orders) {
      directory.rows.clear();
      for (const i of order) {
        const event = events[i];
        if (event) await projector.project(event);
      }
      expect(directory.rows.get('acme-mfb')).toMatchObject({ status: 'ACTIVE', version: 300 });
    }
  });

  it('prefers an explicit payload version', async () => {
    await projector.project({
      ...registered(1),
      payload: { ...registered(1).payload, version: 9 },
    });
    expect(directory.rows.get('acme-mfb')?.version).toBe(9);
  });

  it('ignores unrelated events and institutions it cannot find', async () => {
    await expect(
      projector.project({ type: 'loan.disbursed', version: 1, payload: {} }),
    ).resolves.toBe('ignored');
    await expect(
      projector.project({
        type: 'institution.status_changed',
        version: 1,
        payload: { institutionId: 'unknown', to: 'ACTIVE' },
      }),
    ).resolves.toBe('ignored');
    expect(directory.rows.size).toBe(0);
  });

  it.each<[string, InstitutionEvent]>([
    ['no institution id', { type: 'institution.registered', version: 1, payload: {} }],
    ['no version', { ...registered(0) }],
    ['a fractional version', { ...registered(1.5) }],
    ['an invalid status', statusChanged(1, 'DELETED')],
    [
      'a tenant homed in another region (data residency)',
      { ...registered(1), payload: { ...registered(1).payload, homeRegion: 'eu-west-3' } },
    ],
  ])('rejects an event with %s', async (_case, event) => {
    await expect(projector.project(event)).rejects.toThrow();
    expect(directory.rows.size).toBe(0);
  });

  it('registers the cell endpoint only once per process', async () => {
    const putCell = vi.spyOn(directory, 'putCell');
    await projector.project(registered(100));
    await projector.project(statusChanged(200, 'SUSPENDED'));
    expect(putCell).toHaveBeenCalledTimes(1);
  });
});

describe('projectPendingInstitutions', () => {
  it('reconciles every page of institutions and is a no-op when re-run', async () => {
    const directory = new FakeDirectory();
    const projector = new DirectoryProjector(directory, CELL, {
      slugOf: () => Promise.resolve(undefined),
    });
    const all = Array.from({ length: 501 }, (_, i) => ({
      institutionId: `id-${i}`,
      slug: `lender-${String(i).padStart(4, '0')}`,
      status: 'ACTIVE' as const,
      version: 1000 + i,
    }));
    const source = {
      page: (after: string | undefined, limit: number) =>
        Promise.resolve(all.filter((r) => after === undefined || r.slug > after).slice(0, limit)),
    };

    await expect(projectPendingInstitutions(source, projector)).resolves.toEqual({
      applied: 501,
      stale: 0,
    });
    await expect(projectPendingInstitutions(source, projector)).resolves.toEqual({
      applied: 0,
      stale: 501,
    });
    expect(directory.rows.size).toBe(501);
  });

  it('hands every stale institution to the listener', async () => {
    const directory = new FakeDirectory();
    const projector = new DirectoryProjector(directory, CELL, {
      slugOf: () => Promise.resolve(undefined),
    });
    const institution = {
      institutionId: ID,
      slug: 'acme-mfb',
      status: 'ACTIVE' as const,
      version: 100,
    };
    const source = {
      page: (after: string | undefined) => Promise.resolve(after ? [] : [institution]),
    };
    const onStale = vi.fn(() => Promise.resolve());

    await projectPendingInstitutions(source, projector, onStale);
    expect(onStale).not.toHaveBeenCalled();
    await projectPendingInstitutions(source, projector, onStale);
    expect(onStale).toHaveBeenCalledExactlyOnceWith(institution);
  });
});
