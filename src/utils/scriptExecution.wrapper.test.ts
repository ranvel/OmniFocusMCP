import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promisify } from 'util';

/**
 * The JXA wrapper that carries an OmniJS payload into OmniFocus is generated
 * text, and the read path depends on its exact bytes: the formatDate prelude,
 * the argv line, the escaping of the payload into a template literal. These
 * tests capture what `executeOmniFocusScript` writes to the osascript temp
 * file and pin it as a file snapshot, so the wrapper can be refactored (shared
 * with the write path) without the read path changing by a single byte.
 */

const captured: string[] = [];
let execImpl: (cmd: string) => Promise<{ stdout: string; stderr: string }> = async () => ({
  stdout: '{"ok":true}',
  stderr: '',
});
const execCalls: string[] = [];

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const exec: any = (cmd: string, _opts: unknown, cb?: (err: unknown, out: string, errText: string) => void) => {
    execImpl(cmd).then((r) => cb?.(null, r.stdout, r.stderr), (e) => cb?.(e, '', ''));
  };
  exec[promisify.custom] = (cmd: string) => {
    execCalls.push(cmd);
    return execImpl(cmd);
  };
  return { ...actual, exec };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    writeFileSync: vi.fn((path: unknown, data: unknown) => {
      if (String(path).includes('jxa_wrapper_')) captured.push(String(data));
    }),
    unlinkSync: vi.fn(),
  };
});

const { executeOmniFocusScript, _resetAppHealth } = await import('./scriptExecution.js');

beforeEach(() => {
  captured.length = 0;
  execCalls.length = 0;
  execImpl = async () => ({ stdout: '{"ok":true}', stderr: '' });
  _resetAppHealth();
});

describe('read wrapper (executeOmniFocusScript)', () => {
  it('wraps a payload with no arguments exactly as before', async () => {
    const out = await executeOmniFocusScript('@listTags.js');
    expect(out).toEqual({ ok: true });
    expect(captured).toHaveLength(1);
    await expect(captured[0]).toMatchFileSnapshot('./__snapshots__/wrapper.listTags.jxa.txt');
  });

  it('wraps a payload with arguments exactly as before', async () => {
    await executeOmniFocusScript('@getPerspectiveView.js', ['Today', '5']);
    expect(captured).toHaveLength(1);
    await expect(captured[0]).toMatchFileSnapshot('./__snapshots__/wrapper.getPerspectiveView.jxa.txt');
  });

  it('runs osascript as JavaScript', async () => {
    await executeOmniFocusScript('@listTags.js');
    expect(execCalls[0]).toMatch(/^osascript -l JavaScript "/);
  });

  it('returns the raw stdout when it is not JSON', async () => {
    execImpl = async () => ({ stdout: 'not json\n', stderr: '' });
    expect(await executeOmniFocusScript('@listTags.js')).toBe('not json\n');
  });
});

// --- write tunnel --------------------------------------------------------------

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const { executeOmniFocusWrite, markAppUnresponsive, _testExports } = await import('./scriptExecution.js');
const { escapeContent, jsStringLiteral, buildOmniJsWrapper } = _testExports;

const HERE = dirname(fileURLToPath(import.meta.url));
const ECHO = join(HERE, '__tests__', 'fixtures', 'echoParams.js');

/** Undo the JXA layer: the payload text as evaluateJavascript receives it. */
function payloadOf(jxa: string): string {
  const m = jxa.match(/evaluateJavascript\(`((?:[^`\\]|\\.)*)`\)/);
  if (!m) throw new Error('no evaluateJavascript call in wrapper');
  return new Function('return `' + m[1] + '`')();
}

/** What OmniFocus would hand back: the completion value of the payload. */
function evaluatePayload(payload: string): unknown {
  return new Function('return eval(' + JSON.stringify(payload) + ')')();
}

const HOSTILE = [
  'a"b',
  'back\\slash',
  'tick`s',
  '${injected}',
  'line1\nline2\r\n',
  'sep arated ',
  'emoji 😀',
  'He said "policy \\ infrastructure" — 27" monitor',
  "it's 'quoted'",
  '</script><tag>',
];

describe('write wrapper (executeOmniFocusWrite)', () => {
  it('ships the helpers prelude and the params as one JSON argument', async () => {
    const out = await executeOmniFocusWrite(ECHO, { name: 'x' });
    expect(out).toEqual({ ok: true });
    expect(captured).toHaveLength(1);
    await expect(captured[0]).toMatchFileSnapshot('./__snapshots__/wrapper.write.echoParams.jxa.txt');
  });

  it('never retries a -1712 — a write may have partially applied', async () => {
    execImpl = async () => { throw Object.assign(new Error('AppleEvent timed out (-1712)'), { stderr: '-1712' }); };
    const out = await executeOmniFocusWrite(ECHO, {});
    expect(out).toEqual({ success: false, error: 'AppleEvent timed out (-1712)' });
    expect(execCalls).toHaveLength(1);
  });

  it('returns a transport failure as a result, never a throw', async () => {
    execImpl = async () => { throw new Error('boom'); };
    expect(await executeOmniFocusWrite(ECHO, {})).toEqual({ success: false, error: 'boom' });
  });

  it('reports the open breaker without dispatching', async () => {
    markAppUnresponsive();
    const out = await executeOmniFocusWrite(ECHO, {});
    expect(out.success).toBe(false);
    expect((out as any).error).toMatch(/not responding to AppleEvents/);
    expect(execCalls).toHaveLength(0);
  });

  it('returns unparseable output as a failed result', async () => {
    execImpl = async () => ({ stdout: 'garbage\n', stderr: '' });
    expect(await executeOmniFocusWrite(ECHO, {})).toEqual({
      success: false,
      error: 'Failed to parse result: garbage\n',
    });
  });

  it('normalizes a throw that escaped the payload into the JXA catch', async () => {
    execImpl = async () => ({
      stdout: JSON.stringify({ error: 'Error: move: task not found undefined:1:25' }),
      stderr: '',
    });
    expect(await executeOmniFocusWrite(ECHO, {})).toEqual({ success: false, error: 'move: task not found' });
  });

  it('passes a payload result through unchanged', async () => {
    execImpl = async () => ({ stdout: '{"success":true,"tagId":"T1"}\n', stderr: '' });
    expect(await executeOmniFocusWrite(ECHO, {})).toEqual({ success: true, tagId: 'T1' });
    execImpl = async () => ({ stdout: '{"success":false,"error":"Item not found"}\n', stderr: '' });
    expect(await executeOmniFocusWrite(ECHO, {})).toEqual({ success: false, error: 'Item not found' });
  });
});

describe('payload round trip: params survive both escaping layers', () => {
  it.each(HOSTILE.map(s => [JSON.stringify(s), s]))('%s', (_label, hostile) => {
    const literal = jsStringLiteral(JSON.stringify({ v: hostile, nested: [hostile, 1, null] }));
    const jxa = buildOmniJsWrapper([`const argv = [${literal}];`, 'JSON.parse(argv[0])']);
    expect(evaluatePayload(payloadOf(jxa))).toEqual({ v: hostile, nested: [hostile, 1, null] });
  });

  it('the real write wrapper decodes to the params the caller sent', async () => {
    const params = { name: HOSTILE.join(' | '), note: HOSTILE.join('\n'), tags: HOSTILE, n: 3, flag: false, nothing: null };
    await executeOmniFocusWrite(ECHO, params);
    const result = JSON.parse(evaluatePayload(payloadOf(captured[0])) as string);
    expect(result).toEqual({ success: true, params });
  });

  it('escapeContent alone cannot carry a quote or newline (why jsStringLiteral exists)', () => {
    // The legacy read-side quoting: a double-quoted JS string around escapeContent().
    const broken = `"${escapeContent('a"b')}"`;
    expect(() => new Function('return ' + broken)()).toThrow();
  });
});

describe('normalizeOmniJsError', () => {
  it('strips the JS error class and the source offset', async () => {
    const { normalizeOmniJsError } = await import('./scriptExecution.js');
    expect(normalizeOmniJsError('Error: move: task not found undefined:1:436')).toBe('move: task not found');
    expect(normalizeOmniJsError('Error: repetition: rule did not read back as written undefined:4:18')).toBe(
      'repetition: rule did not read back as written'
    );
    expect(normalizeOmniJsError('plain string')).toBe('plain string');
    expect(normalizeOmniJsError("SyntaxError: Unexpected token ';' undefined:1:0")).toBe(
      "SyntaxError: Unexpected token ';'"
    );
  });
});
