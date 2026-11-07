import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { renderAll } from './api-client-export';
import { WALKTHROUGH } from './api-client/definition';
import type { ApiRequest } from './api-client/model';
import { preRequestScript, testScript, type Tool } from './api-client/scripts';

const requests: ApiRequest[] = WALKTHROUGH.folders.flatMap((f) => f.requests);

/** Variables a request reads: `{{name}}` templates, bearer tokens and `$get('name')`. */
function referenced(req: ApiRequest): string[] {
  const text = [
    req.url,
    JSON.stringify(req.headers ?? {}),
    JSON.stringify(req.body ?? null),
    req.pre ?? '',
    ...req.checks.map((c) => `${c.actual} ${JSON.stringify(c.equals ?? null)}`),
    ...(req.captures ?? []).map((c) => `${c.value} ${c.when ?? ''}`),
  ].join('\n');
  const names = [...text.matchAll(/\{\{(\w+)\}\}|\$get\('(\w+)'\)|"variable":"(\w+)"/g)].map(
    (m) => m[1] ?? m[2] ?? m[3] ?? '',
  );
  return req.token ? [...names, req.token] : names;
}

/** Variables a request stores: captures and `$set('name', …)` in its pre-request snippet. */
function stored(req: ApiRequest): string[] {
  const fromPre = [...(req.pre ?? '').matchAll(/\$set\('(\w+)'/g)].map((m) => m[1] ?? '');
  return [...fromPre, ...(req.captures ?? []).map((c) => c.variable)];
}

describe('API-client collections', () => {
  it('reads only variables that are defaults or stored by an earlier request', () => {
    for (const env of WALKTHROUGH.environments) {
      const known = new Set([...Object.keys(WALKTHROUGH.shared), ...Object.keys(env.values)]);
      for (const req of requests) {
        // A request may read what its own pre-request script stores.
        for (const name of stored(req).filter((n) => req.pre?.includes(`$set('${n}'`))) {
          known.add(name);
        }
        const missing = referenced(req).filter((name) => !known.has(name));
        expect(missing, `${env.name} / ${req.name}`).toEqual([]);
        for (const name of stored(req)) known.add(name);
      }
    }
  });

  it('gives every environment the same variables', () => {
    const [first, ...rest] = WALKTHROUGH.environments;
    for (const env of rest) {
      expect(Object.keys(env.values).sort()).toEqual(Object.keys(first.values).sort());
    }
  });

  it('commits placeholders, never passwords or national ids', () => {
    const values = [
      ...Object.entries(WALKTHROUGH.shared),
      ...WALKTHROUGH.environments.flatMap((e) => Object.entries(e.values)),
    ];
    for (const [key, value] of values) {
      if (/password|national_id/.test(key)) expect(value, key).toMatch(/^<.+>$/);
    }
  });

  it.each<Tool>(['insomnia', 'postman'])('renders %s scripts that parse', (tool) => {
    // Insomnia runs scripts as async functions (top-level await); parse them the same way.
    const AsyncFunction = Object.getPrototypeOf(async function () {
      await Promise.resolve();
    }).constructor as new (body: string) => unknown;
    for (const req of requests) {
      for (const script of [preRequestScript(req, tool), testScript(req, tool)]) {
        expect(() => new AsyncFunction(script), `${tool} / ${req.name}`).not.toThrow();
      }
    }
  });

  it('renders an Insomnia v5 export with one sub-environment per cell', () => {
    const doc = parse(renderAll().get('multi-tenant-lending.insomnia.yaml') ?? '') as {
      type: string;
      collection: { name: string; children: Record<string, unknown>[] }[];
      environments: { data: Record<string, string>; subEnvironments: unknown[] };
    };
    expect(doc.type).toBe('collection.insomnia.rest/5.0');
    expect(doc.collection.map((f) => f.name)).toEqual(WALKTHROUGH.folders.map((f) => f.name));
    expect(doc.environments.subEnvironments).toHaveLength(WALKTHROUGH.environments.length);
    const children = doc.collection.flatMap((f) => f.children);
    expect(children).toHaveLength(requests.length);
    const yaml = JSON.stringify(doc.collection);
    expect(yaml).not.toMatch(/\{\{(?! _\.)/);
    const redirect = children.find((r) => r.name === 'Log in to a lender of the other region: 307');
    expect(redirect).toMatchObject({ settings: { followRedirects: 'off' } });
  });

  it('renders a Postman collection whose variables hold the first environment', () => {
    const files = renderAll();
    const doc = JSON.parse(files.get('multi-tenant-lending.postman_collection.json') ?? '') as {
      info: { schema: string };
      item: { item: { name: string; protocolProfileBehavior?: unknown }[] }[];
      variable: { key: string; value: string }[];
    };
    expect(doc.info.schema).toContain('/v2.1.0/');
    expect(doc.item.flatMap((f) => f.item)).toHaveLength(requests.length);
    const vars = Object.fromEntries(doc.variable.map((v) => [v.key, v.value]));
    expect(vars).toEqual({ ...WALKTHROUGH.shared, ...WALKTHROUGH.environments[0].values });
    const redirect = doc.item
      .flatMap((f) => f.item)
      .find((r) => r.name === 'Log in to a lender of the other region: 307');
    expect(redirect?.protocolProfileBehavior).toEqual({ followRedirects: false });
    expect([...files.keys()]).toEqual([
      'multi-tenant-lending.insomnia.yaml',
      'multi-tenant-lending.postman_collection.json',
      'local-lagos.postman_environment.json',
      'local-paris.postman_environment.json',
    ]);
  });
});
