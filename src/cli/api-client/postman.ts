/*
 * Postman Collection v2.1 export. The collection variables hold every default (shared values
 * plus the first environment), so the collection file works on its own; the environment files
 * switch cells. Hoppscotch imports both and runs the `pm.*` scripts.
 */
import { createHash } from 'node:crypto';

import type { ApiRequest, EnvironmentDef, Folder, Walkthrough } from './model';
import { preRequestScript, testScript } from './scripts';

const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

/** Variables whose values are secrets the reviewer fills in. */
const isSecret = (key: string) => key.includes('password');

/** Deterministic UUID-shaped id. */
function stableUuid(key: string): string {
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const lines = (code: string) => code.split('\n');

function item(req: ApiRequest): Record<string, unknown> {
  const pre = preRequestScript(req, 'postman');
  const events = [
    ...(pre
      ? [{ listen: 'prerequest', script: { type: 'text/javascript', exec: lines(pre) } }]
      : []),
    {
      listen: 'test',
      script: { type: 'text/javascript', exec: lines(testScript(req, 'postman')) },
    },
  ];
  return {
    name: req.name,
    event: events,
    ...(req.followRedirects === false
      ? { protocolProfileBehavior: { followRedirects: false } }
      : {}),
    request: {
      method: req.method,
      header: Object.entries(req.headers ?? {}).map(([key, value]) => ({
        key,
        value,
        type: 'text',
      })),
      auth: req.token
        ? { type: 'bearer', bearer: [{ key: 'token', value: `{{${req.token}}}`, type: 'string' }] }
        : { type: 'noauth' },
      ...(req.body === undefined
        ? {}
        : {
            body: {
              mode: 'raw',
              raw: JSON.stringify(req.body, null, 2),
              options: { raw: { language: 'json' } },
            },
          }),
      url: req.url,
      description: req.description,
    },
  };
}

const folder = (f: Folder) => ({
  name: f.name,
  description: f.description,
  item: f.requests.map(item),
});

export function renderPostmanCollection(w: Walkthrough): string {
  const defaults = { ...w.shared, ...w.environments[0].values };
  const doc = {
    info: {
      _postman_id: stableUuid(w.name),
      name: w.name,
      description: w.description,
      schema: SCHEMA,
    },
    item: w.folders.map(folder),
    variable: Object.entries(defaults).map(([key, value]) => ({ key, value, type: 'string' })),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function renderPostmanEnvironment(w: Walkthrough, env: EnvironmentDef): string {
  const values = { ...w.shared, ...env.values };
  const doc = {
    id: stableUuid(env.key),
    name: `${w.name}: ${env.name}`,
    values: Object.entries(values).map(([key, value]) => ({
      key,
      value,
      type: isSecret(key) ? 'secret' : 'default',
      enabled: true,
    })),
    _postman_variable_scope: 'environment',
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
