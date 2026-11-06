import { describe, expect, it } from 'vitest';

import { originProblem, parseCellOrigins, resolveCell } from './cellConfig';
import { cellLabel, defaultCell } from './cells';

const DEV = { production: false, proxy: true } as const;
const PROD = { production: true, proxy: false } as const;
const PROD_ORIGIN = 'https://eu-west-3.api.example.com';
const PROD_CELLS = JSON.stringify({
  'af-south-1': 'https://af-south-1.api.example.com',
  'eu-west-3': 'https://eu-west-3.api.example.com/',
});

describe('cell allow-list', () => {
  it('maps a known region to its origin (or its dev-proxy prefix)', () => {
    const prod = parseCellOrigins(PROD_CELLS, PROD);
    expect(prod.errors).toEqual([]);
    expect(resolveCell('https://eu-west-3.api.example.com/', prod)).toEqual({
      ok: true,
      region: 'eu-west-3',
      base: 'https://eu-west-3.api.example.com',
    });

    const dev = parseCellOrigins(undefined, DEV);
    expect(resolveCell('http://localhost:3001', dev)).toEqual({
      ok: true,
      region: 'eu-west-3',
      base: '/cell/eu-west-3',
    });
    expect(defaultCell(dev)).toEqual({ region: 'af-south-1', base: '/cell/af-south-1' });
    expect(cellLabel('/cell/eu-west-3', dev)).toBe('eu-west-3');
    expect(cellLabel('https://af-south-1.api.example.com', prod)).toBe('af-south-1');
  });

  it.each([
    'https://evil.example.com',
    'https://af-south-1.api.example.com.evil.example.com',
    'https://af-south-1.api.example.com/../steal',
    'http://af-south-1.api.example.com',
    'javascript:alert(1)',
    '',
  ])('refuses the unknown or poisoned base %j', (announced) => {
    const result = resolveCell(announced, parseCellOrigins(PROD_CELLS, PROD));
    expect(result.ok).toBe(false);
  });

  it('rejects http:// for non-loopback hosts, and all http:// in a production build', () => {
    expect(originProblem('http://cells.example.com', false)).toMatch(/https/);
    expect(originProblem('http://localhost:3000', false)).toBeNull();
    expect(originProblem('http://127.0.0.1:3000', false)).toBeNull();
    expect(originProblem('http://localhost:3000', true)).toMatch(/production/);
    expect(originProblem('https://cells.example.com/api', true)).toMatch(/bare origin/);

    const prod = parseCellOrigins(
      JSON.stringify({ 'af-south-1': 'http://cells.example.com', 'eu-west-3': PROD_ORIGIN }),
      PROD,
    );
    expect(Object.keys(prod.origins)).toEqual(['eu-west-3']);
    expect(prod.defaultRegion).toBe('eu-west-3');
    expect(prod.errors.join()).toMatch(/af-south-1 .* rejected: must use https/);
  });

  it('refuses to start a production build that only has the local http:// cells', () => {
    const prod = parseCellOrigins(undefined, PROD);
    expect(prod.origins).toEqual({});
    expect(() => defaultCell(prod)).toThrow(/No API cell is configured/);
  });

  it('reports malformed configuration instead of trusting it', () => {
    expect(parseCellOrigins('not json', DEV).errors[0]).toMatch(/JSON object/);
    expect(parseCellOrigins('{"../x":"https://a.example.com"}', DEV).errors[0]).toMatch(
      /invalid region/,
    );
    expect(parseCellOrigins(PROD_CELLS, { ...PROD, defaultRegion: 'us-east-1' }).errors[0]).toMatch(
      /not in the allow-list/,
    );
  });
});
