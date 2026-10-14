import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildWorld } from './omniJsFake.js';
import { loadHelpers, runWriteScript, SCRIPTS_DIR } from './runWriteScript.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ECHO = join(HERE, 'fixtures', 'echoParams.js');

/**
 * `_writeHelpers.js` run under Node against the OmniJS fake. These pin what the
 * helpers DO — which item a name resolves to, how a date is built — not how
 * they are spelled.
 */

afterEach(() => vi.useRealTimers());

describe('harness', () => {
  it('runs a script with params as the one JSON argument', () => {
    const w = buildWorld();
    const params = { name: 'He said "hi" \\ `x` ${y}', n: [1, null] };
    expect(runWriteScript(ECHO, params, w.globals)).toEqual({ success: true, params });
  });

  it('runWrite turns a throw into { success: false, error }', () => {
    const w = buildWorld();
    const h = loadHelpers(w.globals, ['{}']);
    const out = JSON.parse(h.runWrite(() => { throw new Error('Item not found'); }));
    expect(out).toEqual({ success: false, error: 'Item not found' });
  });

  it('resolves scripts relative to omnifocusScripts/', () => {
    expect(SCRIPTS_DIR).toMatch(/omnifocusScripts$/);
  });
});

describe('firstByName', () => {
  it('prefers an exact match, then falls back to a case-insensitive one', () => {
    const w = buildWorld();
    const lower = w.tag('work');
    const upper = w.tag('Work');
    const h = loadHelpers(w.globals);
    expect(h.firstByName(w.globals.flattenedTags, 'Work')).toBe(upper);
    expect(h.firstByName(w.globals.flattenedTags, 'work')).toBe(lower);
    expect(h.firstByName(w.globals.flattenedTags, 'WORK')).toBe(lower);
    expect(h.firstByName(w.globals.flattenedTags, 'Home')).toBeNull();
  });
});

describe('splitPath', () => {
  it('splits on / and drops empty components', () => {
    const h = loadHelpers(buildWorld().globals);
    expect(h.splitPath('Work/Engineering')).toEqual(['Work', 'Engineering']);
    expect(h.splitPath('/Work//Eng/')).toEqual(['Work', 'Eng']);
    expect(h.splitPath('/')).toEqual([]);
    expect(h.splitPath('')).toEqual([]);
  });
});

describe('dateFromParts', () => {
  it('builds a local wall-clock date from parts', () => {
    const h = loadHelpers(buildWorld().globals);
    const d: Date = h.dateFromParts({ y: 2026, m: 4, d: 10, h: 17, mi: 30, s: 0 });
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 4, 10, 17, 30]);
  });

  it('null clears', () => {
    const h = loadHelpers(buildWorld().globals);
    expect(h.dateFromParts(null)).toBeNull();
    expect(h.dateFromParts(undefined)).toBeNull();
  });

  it('never rolls over when written on the 31st toward a shorter month (#91)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T12:00:00'));
    const h = loadHelpers(buildWorld().globals);
    const d: Date = h.dateFromParts({ y: 2026, m: 11, d: 1, h: 0, mi: 0, s: 0 });
    expect([d.getMonth() + 1, d.getDate()]).toEqual([11, 1]);
    const feb: Date = h.dateFromParts({ y: 2026, m: 2, d: 28, h: 9, mi: 0, s: 0 });
    expect([feb.getMonth() + 1, feb.getDate()]).toEqual([2, 28]);
  });
});

describe('ensureTag', () => {
  it('returns the existing tag, matching case-insensitively', () => {
    const w = buildWorld();
    const t = w.tag('Errands');
    const h = loadHelpers(w.globals);
    expect(h.ensureTag('Errands')).toBe(t);
    expect(h.ensureTag('errands')).toBe(t);
    expect(w.tags).toHaveLength(1);
  });

  it('creates a top-level tag when there is none', () => {
    const w = buildWorld();
    const h = loadHelpers(w.globals);
    const t = h.ensureTag('New');
    expect(t.name).toBe('New');
    expect(t.parent).toBeNull();
    expect(w.tags).toEqual([t]);
    expect(h.ensureTag('New')).toBe(t);
  });
});
