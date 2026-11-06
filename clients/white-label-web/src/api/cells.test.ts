import { describe, expect, it } from 'vitest';

import { cellLabel, clientBaseFor, parseCellMap } from './cells';

describe('cell routing', () => {
  it('maps directory base URLs to dev-proxy prefixes', () => {
    const map = parseCellMap('http://localhost:3001/=/cell/eu-west-3');
    expect(clientBaseFor('http://localhost:3001', map)).toBe('/cell/eu-west-3');
    expect(clientBaseFor('https://af-south-1.api.example.com', map)).toBe(
      'https://af-south-1.api.example.com',
    );
    expect(cellLabel('/cell/eu-west-3')).toBe('eu-west-3');
  });
});
