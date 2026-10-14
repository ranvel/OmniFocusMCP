import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

/**
 * Run the OmniJS write payloads under Node, against fakes of the OmniJS
 * globals (see omniJsFake.ts). The helpers file and the script are loaded as
 * plain text — the same bytes the tunnel ships into OmniFocus — with the
 * fake's globals bound as function parameters. `argv` is injected the way
 * the tunnel does it, so the JSON round trip is exercised too.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCRIPTS_DIR = join(HERE, '..', 'omnifocusScripts');
const HELPERS = readFileSync(join(SCRIPTS_DIR, '_writeHelpers.js'), 'utf8');

/** Every function `_writeHelpers.js` declares, as an object. */
export function loadHelpers(globals: Record<string, unknown>, argv: string[] = []): Record<string, any> {
  const names = [...HELPERS.matchAll(/^function (\w+)\(/gm)].map(m => m[1]);
  const body = `${HELPERS}\nreturn { ${names.join(', ')} };`;
  return new Function('argv', ...Object.keys(globals), body)(argv, ...Object.values(globals));
}

/**
 * Evaluate a write script by name (or an absolute path) with `params` as its
 * one JSON argument and return the parsed result.
 */
export function runWriteScript(
  script: string,
  params: unknown,
  globals: Record<string, unknown>
): any {
  const path = script.startsWith('/') ? script : join(SCRIPTS_DIR, script);
  const src = readFileSync(path, 'utf8');
  // Direct eval returns the completion value of the script's last expression,
  // exactly what evaluateJavascript hands back inside OmniFocus.
  const body = `${HELPERS}\nreturn eval(${JSON.stringify(src)});`;
  const out = new Function('argv', ...Object.keys(globals), body)(
    [JSON.stringify(params)],
    ...Object.values(globals)
  );
  return JSON.parse(out);
}
