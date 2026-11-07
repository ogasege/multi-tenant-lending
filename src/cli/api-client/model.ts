/*
 * Tool-neutral model of the API-client walkthrough. `definition.ts` describes the requests
 * once; `insomnia.ts` and `postman.ts` render it to each tool's export format, so the
 * collections cannot drift apart.
 *
 * Template syntax in urls, headers and bodies is `{{name}}`. Script snippets use a few
 * neutral helpers that each renderer maps to its tool's API:
 *
 * - `$get('name')`: read a variable (environment, then collection defaults);
 * - `$set('name', value)`: store a variable for later requests;
 * - `$status`: the response status code;
 * - `$header('Name')`: a response header value (use the server's casing);
 * - `body`: the parsed JSON response (`{}` when there is none);
 * - `$uuid()`: a random v4 UUID.
 */
import { createHash } from 'node:crypto';

/** One assertion on the response; `actual` is a script expression. */
export interface Check {
  name: string;
  actual: string;
  /** Deep-equals a literal, or a variable when given as `{ variable }`. */
  equals?: string | number | boolean | { variable: string };
  oneOf?: readonly (string | number)[];
  exists?: true;
  absent?: true;
}

export interface Capture {
  variable: string;
  /** Script expression; evaluated only when `when` (an expression) holds, if given. */
  value: string;
  when?: string;
}

/** Script snippets that need tool-specific code (for example sending extra requests). */
export interface ToolScripts {
  insomnia: string;
  postman: string;
}

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface ApiRequest {
  /** Stable id used to derive the tools' ids; never shown. */
  key: string;
  name: string;
  description: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  /** Variable holding the bearer token; omitted for public routes. */
  token?: string;
  headers?: Readonly<Record<string, string>>;
  body?: Json;
  /** `false` keeps a redirect visible instead of following it. */
  followRedirects?: boolean;
  /** Neutral pre-request snippet. */
  pre?: string;
  /** Tool-specific pre-request code, run after `pre`. */
  preTool?: ToolScripts;
  checks: readonly Check[];
  captures?: readonly Capture[];
}

export interface Folder {
  key: string;
  name: string;
  description: string;
  requests: readonly ApiRequest[];
}

export interface EnvironmentDef {
  key: string;
  name: string;
  values: Readonly<Record<string, string>>;
}

export interface Walkthrough {
  name: string;
  description: string;
  /** Values shared by every environment (placeholders for secrets live here). */
  shared: Readonly<Record<string, string>>;
  /** Cell-specific values; the first one is also the Postman collection default. */
  environments: readonly [EnvironmentDef, ...EnvironmentDef[]];
  folders: readonly Folder[];
}

/** Deterministic id from a key, so regenerated files only change when content does. */
export function stableId(prefix: string, key: string): string {
  return `${prefix}_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
}
