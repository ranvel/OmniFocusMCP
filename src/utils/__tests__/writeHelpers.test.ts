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

describe('resolveFolderByPath', () => {
  function tree() {
    const w = buildWorld();
    const work = w.folder('Work');
    const eng = w.folder('Engineering', work);
    const platform = w.folder('Platform', eng);
    const home = w.folder('Home');
    const homeEng = w.folder('Engineering', home);
    return { w, h: loadHelpers(w.globals), work, eng, platform, home, homeEng };
  }

  it('resolves a single name to the first folder with that name', () => {
    const { h, work, eng } = tree();
    expect(h.resolveFolderByPath('Work')).toBe(work);
    expect(h.resolveFolderByPath('Engineering')).toBe(eng);
    expect(h.resolveFolderByPath('work')).toBe(work);
  });

  it('walks the ancestor chain for a multi-segment path', () => {
    const { h, eng, homeEng } = tree();
    expect(h.resolveFolderByPath('Work/Engineering')).toBe(eng);
    expect(h.resolveFolderByPath('Home/Engineering')).toBe(homeEng);
  });

  it('handles three-level paths correctly', () => {
    const { h, platform } = tree();
    expect(h.resolveFolderByPath('Work/Engineering/Platform')).toBe(platform);
    expect(h.resolveFolderByPath('Home/Engineering/Platform')).toBeNull();
  });

  it('requires every named ancestor to match', () => {
    const { h } = tree();
    expect(h.resolveFolderByPath('Nope/Engineering')).toBeNull();
    expect(h.resolveFolderByPath('Work/Platform')).toBeNull();
  });

  it('strips empty segments from paths with trailing slashes', () => {
    const { h, work, eng } = tree();
    expect(h.resolveFolderByPath('Work/')).toBe(work);
    expect(h.resolveFolderByPath('/Work//Engineering/')).toBe(eng);
  });

  it('resolves nothing for component-less paths, so callers fail loudly', () => {
    const { h } = tree();
    for (const path of ['', '/', '//']) {
      expect(h.resolveFolderByPath(path), `path ${JSON.stringify(path)}`).toBeNull();
    }
  });

  it('keeps special characters in folder names', () => {
    const w = buildWorld();
    const parent = w.folder('Parent');
    const child = w.folder('Child "Folder" \\ back', parent);
    const h = loadHelpers(w.globals);
    expect(h.resolveFolderByPath('Parent/Child "Folder" \\ back')).toBe(child);
  });
});

describe('resolveProjectByPath', () => {
  function tree() {
    const w = buildWorld();
    const work = w.folder('Work');
    const personal = w.folder('Personal');
    const committees = w.folder('Committees', personal);
    const marketing = w.project('Marketing', null);
    const workOutreach = w.project('Community Outreach', work);
    const committeeOutreach = w.project('Outreach', committees);
    const personalOutreach = w.project('Community Outreach', personal);
    return { w, h: loadHelpers(w.globals), marketing, workOutreach, committeeOutreach, personalOutreach };
  }

  it('resolves an unqualified project name', () => {
    const { h, marketing } = tree();
    expect(h.resolveProjectByPath('Marketing')).toBe(marketing);
    expect(h.resolveProjectByPath('marketing')).toBe(marketing);
  });

  it('qualifies by folder for a path', () => {
    const { h, workOutreach, personalOutreach } = tree();
    expect(h.resolveProjectByPath('Work/Community Outreach')).toBe(workOutreach);
    expect(h.resolveProjectByPath('Personal/Community Outreach')).toBe(personalOutreach);
  });

  it('handles nested folder paths', () => {
    const { h, committeeOutreach } = tree();
    expect(h.resolveProjectByPath('Personal/Committees/Outreach')).toBe(committeeOutreach);
    expect(h.resolveProjectByPath('Work/Committees/Outreach')).toBeNull();
  });

  it('resolves nothing for component-less paths, so callers fail loudly', () => {
    const { h } = tree();
    for (const path of ['', '/', '//']) {
      expect(h.resolveProjectByPath(path), `path ${JSON.stringify(path)}`).toBeNull();
    }
  });

  it('does not match a root-level project against a folder path', () => {
    const { h } = tree();
    expect(h.resolveProjectByPath('Work/Marketing')).toBeNull();
  });
});

/**
 * Run applyRepetition against the fake. Pins what it DOES — which anchor it
 * picks for which dates, that it refuses a rule that reads back differently —
 * not how it is spelled.
 */
describe('applyRepetition (#116)', () => {
  const D = new Date('2026-10-02T12:00:00');
  const fixedWeekly = { method: 'fixed', recurrence: 'FREQ=WEEKLY;BYDAY=FR', schedule: 'Regularly', anchorKey: null, catchUp: false, isProject: false };

  function target(dates: { dueDate?: Date; deferDate?: Date; plannedDate?: Date }, isProject = false) {
    const w = buildWorld();
    const item = isProject ? w.project('P') : w.task('T', null);
    if (dates.dueDate) item.dueDate = dates.dueDate;
    if (dates.deferDate) item.deferDate = dates.deferDate;
    if (dates.plannedDate && !isProject) (item as any).plannedDate = dates.plannedDate;
    return { w, item, h: loadHelpers(w.globals) };
  }
  const stored = (item: any) => ({
    ruleString: item.repetitionRule.ruleString,
    schedule: String(item.repetitionRule.scheduleType),
    anchorKey: String(item.repetitionRule.anchorDateKey),
    catchUp: item.repetitionRule.catchUpAutomatically,
  });

  it.each([
    ['due only', { dueDate: D }, 'DueDate'],
    ['defer only', { deferDate: D }, 'DeferDate'],
    ['due and defer', { dueDate: D, deferDate: D }, 'DueDate'],
    ['planned only', { plannedDate: D }, 'PlannedDate'],
    ['no dates at all', {}, 'DeferDate'],
  ] as const)('defaults sensibly for a task with %s', (_label, dates, expected) => {
    const { item, h } = target(dates);
    h.applyRepetition(item, fixedWeekly);
    expect(stored(item)).toEqual({ ruleString: 'FREQ=WEEKLY;BYDAY=FR', schedule: 'Regularly', anchorKey: expected, catchUp: false });
  });

  it('honors an explicit anchor over the default, whatever dates exist', () => {
    const { item, h } = target({ dueDate: D, deferDate: D });
    expect(h.applyRepetition(item, { ...fixedWeekly, anchorKey: 'DeferDate' })).toBe('defer');
    expect(stored(item).anchorKey).toBe('DeferDate');
  });

  it('reports the anchor it actually stored, so a default is never silent', () => {
    expect(target({ deferDate: D }).h.applyRepetition(target({ deferDate: D }).item, fixedWeekly)).toBe('defer');
    const due = target({ dueDate: D });
    expect(due.h.applyRepetition(due.item, fixedWeekly)).toBe('due');
    const planned = target({ plannedDate: D });
    expect(planned.h.applyRepetition(planned.item, fixedWeekly)).toBe('planned');
  });

  it('passes catchUp through', () => {
    const { item, h } = target({ deferDate: D });
    h.applyRepetition(item, { ...fixedWeekly, catchUp: true });
    expect(stored(item).catchUp).toBe(true);
  });

  it('never defaults a project to the planned date (projects have none)', () => {
    const { item, h } = target({}, true);
    h.applyRepetition(item, { ...fixedWeekly, isProject: true });
    expect(stored(item).anchorKey).toBe('DeferDate');
  });

  it('sets the rule on the project when handed its root task', () => {
    const { w, item, h } = target({ dueDate: D }, true);
    h.applyRepetition((item as any).task, { method: 'fixed', recurrence: 'FREQ=MONTHLY', schedule: 'Regularly', anchorKey: null, catchUp: false, isProject: true });
    expect(stored(w.projects[0]).anchorKey).toBe('DueDate');
  });

  it.each([
    ['start-after-completion', 'DeferDate', 'defer'],
    ['due-after-completion', 'DueDate', 'due'],
  ] as const)('%s writes FromCompletion anchored on %s regardless of dates', (method, key, word) => {
    for (const dates of [{}, { dueDate: D }, { deferDate: D }, { dueDate: D, deferDate: D }]) {
      const { item, h } = target(dates);
      const anchor = h.applyRepetition(item, { method, recurrence: 'FREQ=MONTHLY;INTERVAL=3', schedule: 'FromCompletion', anchorKey: key, catchUp: false, isProject: false });
      expect(stored(item)).toEqual({ ruleString: 'FREQ=MONTHLY;INTERVAL=3', schedule: 'FromCompletion', anchorKey: key, catchUp: false });
      expect(anchor).toBe(word);
    }
  });

  it('throws if OmniFocus stores something other than what was asked', () => {
    const { w, item, h } = target({ deferDate: D });
    w.ruleTamper = r => { if (r) r.ruleString = 'FREQ=DAILY'; };
    expect(() => h.applyRepetition(item, fixedWeekly)).toThrow(/did not read back as written/);
  });

  it('names the version requirement rather than failing obscurely on old OmniFocus', () => {
    const w = buildWorld();
    w.anchorDateKeySupported = false;
    const item = w.task('T', null);
    expect(() => loadHelpers(w.globals).applyRepetition(item, fixedWeekly)).toThrow(/requires OmniFocus 4.7 or later/);
  });

  it('builds the changedProperties label from the method and the stored anchor', () => {
    const h = loadHelpers(buildWorld().globals);
    expect(h.repetitionLabel(fixedWeekly, 'defer')).toBe('repetition (fixed, from defer date)');
    expect(h.repetitionLabel({ ...fixedWeekly, catchUp: true }, 'due')).toBe('repetition (fixed, from due date, catch up)');
    expect(h.repetitionLabel({ ...fixedWeekly, method: 'start-after-completion' }, 'defer')).toBe('repetition (start after completion)');
    expect(h.repetitionLabel({ ...fixedWeekly, method: 'due-after-completion' }, 'due')).toBe('repetition (due after completion)');
  });
});

describe('applyReviewInterval (#139)', () => {
  it.each([
    [{ steps: 2, unit: 'weeks' }],
    [{ steps: 1, unit: 'months' }],
    [{ steps: 10, unit: 'days' }],
    [{ steps: 1, unit: 'years' }],
  ])('writes %o and re-assigns the mutated copy', spec => {
    const w = buildWorld();
    const p = w.project('P');
    loadHelpers(w.globals).applyReviewInterval(p, spec);
    expect(p.reviewInterval.steps).toBe(spec.steps);
    expect(p.reviewInterval.unit).toBe(spec.unit);
  });

  it('fails loudly when OmniFocus stores something other than what was asked', () => {
    const w = buildWorld();
    const p = w.project('P');
    p.validUnits = ['day', 'week', 'month', 'year'];
    expect(() => loadHelpers(w.globals).applyReviewInterval(p, { steps: 2, unit: 'weeks' })).toThrow(/did not read back as written/);
  });
});

describe('addTagsByName', () => {
  it('attaches existing tags, creates missing ones, and skips one that fails', () => {
    const w = buildWorld();
    const t = w.task('T', null);
    const urgent = w.tag('urgent');
    const h = loadHelpers(w.globals);
    const realAddTag = t.addTag.bind(t);
    t.addTag = (tag: any) => { if (tag.name === 'boom') throw new Error('nope'); realAddTag(tag); };
    h.addTagsByName(t, ['urgent', 'boom', 'new']);
    expect(t.tags.map(x => x.name)).toEqual(['urgent', 'new']);
    expect(t.tags[0]).toBe(urgent);
  });
});
