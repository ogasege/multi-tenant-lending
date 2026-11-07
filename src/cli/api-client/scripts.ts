/*
 * Renders the neutral script helpers of `model.ts` to Insomnia (`insomnia.*`) or Postman
 * (`pm.*`, which Hoppscotch also runs) scripts.
 */
import type { ApiRequest, Check } from './model';

export type Tool = 'insomnia' | 'postman';

interface ToolApi {
  get: string;
  set: string;
  status: string;
  header: string;
  test: string;
  expect: string;
  json: string;
  /** Declares the `set` function when the tool needs one. */
  setPrelude: string;
}

const API: Readonly<Record<Tool, ToolApi>> = {
  insomnia: {
    get: 'insomnia.variables.get(',
    set: 'insomnia.environment.set(',
    status: 'insomnia.response.code',
    header: 'insomnia.response.headers.get(',
    test: 'insomnia.test',
    expect: 'insomnia.expect',
    json: 'insomnia.response.json()',
    setPrelude: '',
  },
  postman: {
    get: 'pm.variables.get(',
    set: 'setVar(',
    status: 'pm.response.code',
    header: 'pm.response.headers.get(',
    test: 'pm.test',
    expect: 'pm.expect',
    json: 'pm.response.json()',
    setPrelude: [
      '// Environment first; collection variables keep values when no environment is',
      '// selected (Hoppscotch has none, hence the try).',
      'const setVar = (name, value) => {',
      '  pm.environment.set(name, value);',
      '  try {',
      '    pm.collectionVariables.set(name, value);',
      '  } catch (e) {',
      '    // not supported here',
      '  }',
      '};',
    ].join('\n'),
  },
};

const UUID_PRELUDE = [
  'const $uuid = () =>',
  "  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {",
  '    const r = Math.floor(Math.random() * 16);',
  "    return (c === 'x' ? r : (r % 4) + 8).toString(16);",
  '  });',
].join('\n');

/** Maps the neutral helpers in `code` to the tool's API. */
export function toToolCode(code: string, tool: Tool): string {
  const api = API[tool];
  return code
    .replaceAll('$get(', api.get)
    .replaceAll('$set(', api.set)
    .replaceAll('$status', api.status)
    .replaceAll('$header(', api.header);
}

function preludes(code: string, tool: Tool): string[] {
  const out: string[] = [];
  if (code.includes('$uuid(')) out.push(UUID_PRELUDE);
  const setPrelude = API[tool].setPrelude;
  if (code.includes('$set(') && setPrelude) out.push(setPrelude);
  return out;
}

function assertion(check: Check, tool: Tool): string {
  const api = API[tool];
  const actual = toToolCode(check.actual, tool);
  const expect = `${api.expect}(${actual})`;
  if (check.exists) return `${expect}.to.exist;`;
  if (check.absent) return `${expect}.to.not.exist;`;
  if (check.oneOf) return `${expect}.to.be.oneOf(${JSON.stringify(check.oneOf)});`;
  if (check.equals === undefined) throw new Error(`check "${check.name}" has no expectation`);
  const expected =
    typeof check.equals === 'object'
      ? `${api.get}'${check.equals.variable}')`
      : JSON.stringify(check.equals);
  return `${expect}.to.eql(${expected});`;
}

/** Pre-request script, or `''` when the request has none. */
export function preRequestScript(req: ApiRequest, tool: Tool): string {
  const neutral = req.pre ?? '';
  const parts = [...preludes(neutral, tool)];
  if (neutral) parts.push(toToolCode(neutral, tool));
  if (req.preTool) parts.push(req.preTool[tool]);
  return parts.join('\n');
}

/** After-response (Insomnia) / test (Postman) script with the checks and captures. */
export function testScript(req: ApiRequest, tool: Tool): string {
  const api = API[tool];
  const captures = req.captures ?? [];
  const neutral = [...req.checks.map((c) => c.actual), ...captures.map((c) => c.value)].join('\n');
  const usesSet = captures.length > 0;
  const parts = preludes(usesSet ? `${neutral}\n$set(` : neutral, tool);
  parts.push(
    [
      'let body = {};',
      'try {',
      `  body = ${api.json} ?? {};`,
      '} catch (e) {',
      '  // no JSON body',
      '}',
    ].join('\n'),
  );
  for (const check of req.checks) {
    parts.push(
      `${api.test}(${JSON.stringify(check.name)}, () => {\n  ${assertion(check, tool)}\n});`,
    );
  }
  for (const capture of captures) {
    const set = `${api.set}'${capture.variable}', ${toToolCode(capture.value, tool)});`;
    const guarded = capture.when ? `if (${toToolCode(capture.when, tool)}) ${set}` : set;
    parts.push(`try {\n  ${guarded}\n} catch (e) {\n  // not in this response\n}`);
  }
  return parts.join('\n');
}

/** `{{name}}` → Insomnia's `{{ _.name }}`; Postman keeps `{{name}}`. */
export function toToolTemplate(text: string, tool: Tool): string {
  return tool === 'insomnia' ? text.replace(/\{\{(\w+)\}\}/g, '{{ _.$1 }}') : text;
}
