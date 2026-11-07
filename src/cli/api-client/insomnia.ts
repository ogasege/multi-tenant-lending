/*
 * Insomnia v5 export (`collection.insomnia.rest/5.0`, schema 5.1): one YAML file with the
 * collection, a base environment (shared values) and one sub-environment per cell.
 */
import { stringify } from 'yaml';

import { type ApiRequest, type Folder, stableId, type Walkthrough } from './model';
import { preRequestScript, testScript, toToolTemplate } from './scripts';

/** Fixed timestamp keeps the export deterministic. */
const CREATED = Date.UTC(2026, 10, 7);

const meta = (id: string, sortKey: number, description = '') => ({
  id,
  created: CREATED,
  modified: CREATED,
  sortKey,
  description,
});

const t = (text: string) => toToolTemplate(text, 'insomnia');

function request(req: ApiRequest, index: number): Record<string, unknown> {
  const pre = preRequestScript(req, 'insomnia');
  const after = testScript(req, 'insomnia');
  return {
    url: t(req.url),
    name: req.name,
    meta: {
      ...meta(stableId('req', req.key), index),
      isPrivate: false,
      description: req.description,
    },
    method: req.method,
    ...(req.body === undefined
      ? {}
      : { body: { mimeType: 'application/json', text: t(JSON.stringify(req.body, null, 2)) } }),
    headers: Object.entries(req.headers ?? {}).map(([name, value]) => ({ name, value: t(value) })),
    authentication: req.token
      ? { type: 'bearer', token: t(`{{${req.token}}}`), prefix: '', disabled: false }
      : { type: 'none' },
    scripts: { ...(pre ? { preRequest: pre } : {}), afterResponse: after },
    settings: {
      renderRequestBody: true,
      encodeUrl: true,
      followRedirects: req.followRedirects === false ? 'off' : 'global',
      cookies: { send: false, store: false },
      rebuildPath: true,
    },
  };
}

function folder(f: Folder, index: number): Record<string, unknown> {
  return {
    name: f.name,
    meta: meta(stableId('fld', f.key), index, f.description),
    children: f.requests.map((r, i) => request(r, i)),
  };
}

export function renderInsomnia(w: Walkthrough): string {
  const doc = {
    type: 'collection.insomnia.rest/5.0',
    schema_version: '5.1',
    name: w.name,
    meta: {
      id: stableId('wrk', w.name),
      created: CREATED,
      modified: CREATED,
      description: w.description,
    },
    collection: w.folders.map((f, i) => folder(f, i)),
    cookieJar: {
      name: 'Default Jar',
      meta: { id: stableId('jar', w.name), created: CREATED, modified: CREATED },
    },
    environments: {
      name: 'Base Environment',
      meta: {
        id: stableId('env', `${w.name}.base`),
        created: CREATED,
        modified: CREATED,
        isPrivate: false,
      },
      data: w.shared,
      subEnvironments: w.environments.map((env, i) => ({
        name: env.name,
        meta: { ...meta(stableId('env', env.key), i), isPrivate: false },
        data: env.values,
      })),
    },
  };
  return stringify(doc, { lineWidth: 0 });
}
