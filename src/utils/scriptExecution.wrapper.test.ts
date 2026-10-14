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
