import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildWorld, RepetitionRule } from './omniJsFake.js';
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

describe('resolveTaskOrProject', () => {
  it('finds a task by id, then falls back to its name', () => {
    const w = buildWorld();
    const t = w.task('Write report', null, 'T1');
    const h = loadHelpers(w.globals);
    expect(h.resolveTaskOrProject('task', 'T1', undefined)).toBe(t);
    expect(h.resolveTaskOrProject('task', 'stale', 'Write report')).toBe(t);
    expect(h.resolveTaskOrProject('task', undefined, 'write REPORT')).toBe(t);
    expect(h.resolveTaskOrProject('task', 'stale', 'nothing')).toBeNull();
  });

  it('finds a project by project id, by its root task id, or by name (#77)', () => {
    const w = buildWorld();
    const p = w.project('Work', null, 'P1');
    const h = loadHelpers(w.globals);
    expect(h.resolveTaskOrProject('project', 'P1', undefined)).toBe(p);
    expect(h.resolveTaskOrProject('project', p.task.id.primaryKey, undefined)).toBe(p);
    expect(h.resolveTaskOrProject('project', undefined, 'work')).toBe(p);
    expect(h.resolveProjectByIdOrRootTaskId('nope')).toBeNull();
  });

  it('does not hand back a task when asked for a project with a task id', () => {
    const w = buildWorld();
    const P = w.project('Work');
    w.task('child', P, 'C1');
    const h = loadHelpers(w.globals);
    expect(h.resolveTaskOrProject('project', 'C1', undefined)).toBeNull();
  });

  it('itemId reports the root task id for a project', () => {
    const w = buildWorld();
    const p = w.project('Work', null, 'P1');
    const t = w.task('x', p, 'T1');
    const h = loadHelpers(w.globals);
    expect(h.itemId(p, 'project')).toBe('P1');
    expect(h.itemId(t, 'task')).toBe('T1');
  });
});

describe('occurrence guard (#124)', () => {
  const rule = () => new RepetitionRule('FREQ=DAILY', null, 'Regularly', 'DueDate', false);

  it('trips for a completed or dropped occurrence of a repeating task', () => {
    const w = buildWorld();
    const h = loadHelpers(w.globals);
    const live = w.task('Daily', null, 'D');
    live.repetitionRule = rule();
    const done = live.markComplete();
    expect(h.isPastOccurrence(done, 'task')).toBe(true);
    expect(h.isPastOccurrence(live, 'task')).toBe(false);
    live.drop(false);
    const dropped = w.tasks.find(t => t.dropDate)!;
    expect(h.isPastOccurrence(dropped, 'task')).toBe(true);
    expect(() => h.assertLiveOccurrence(done, 'task')).toThrow(/completed occurrence of a repeating item/);
    expect(() => h.assertLiveOccurrence(live, 'task')).not.toThrow();
  });

  it('does not trip for a completed task that does not repeat', () => {
    const w = buildWorld();
    const t = w.task('Once', null);
    t.markComplete();
    expect(loadHelpers(w.globals).isPastOccurrence(t, 'task')).toBe(false);
  });

  it('judges a repeating project by its own status, not its id shape', () => {
    const w = buildWorld();
    const h = loadHelpers(w.globals);
    const live = w.project('Weekly review', null, 'bY_WHmMzWfC.116');
    live.repetitionRule = rule();
    expect(h.isPastOccurrence(live, 'project')).toBe(false);
    const done = w.project('Weekly review', null, 'bY_WHmMzWfC.116.43');
    done.repetitionRule = rule();
    done.markComplete();
    expect(h.isPastOccurrence(done, 'project')).toBe(true);
  });
});
