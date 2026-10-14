import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildWorld } from '../../utils/__tests__/omniJsFake.js';
import { runWriteScript } from '../../utils/__tests__/runWriteScript.js';

vi.mock('../../utils/scriptExecution.js', () => ({
  executeOmniFocusWrite: vi.fn(async () => ({ success: true, projectId: 'P1' })),
}));

import { executeOmniFocusWrite } from '../../utils/scriptExecution.js';
import { addProject, buildAddProjectScriptParams, type AddProjectParams } from './addProject.js';

const tunnel = vi.mocked(executeOmniFocusWrite);
const sent = () => tunnel.mock.calls[0][1] as any;
const makeParams = (overrides: Partial<AddProjectParams> = {}): AddProjectParams => ({ name: 'Test Project', ...overrides });
const run = (params: unknown, w = buildWorld()) => ({ out: runWriteScript('addProject.js', params, w.globals), w });
const script = (overrides: Partial<AddProjectParams> = {}) => buildAddProjectScriptParams(makeParams(overrides));

beforeEach(() => {
  tunnel.mockClear();
  tunnel.mockResolvedValue({ success: true, projectId: 'P1' });
});

describe('addProject: what the primitive sends', () => {
  describe('folder handling', () => {
    it('creates project at root when no folder specified', async () => {
      await addProject(makeParams());
      expect(tunnel).toHaveBeenCalledWith('@addProject.js', { name: 'Test Project', sequential: false });
    });

    it('passes a single folder name through', () => {
      expect(script({ folderName: 'Work' }).folderName).toBe('Work');
    });

    it('passes a nested path through for the script to resolve', () => {
      expect(script({ folderName: 'Work/Engineering' }).folderName).toBe('Work/Engineering');
    });
  });

  describe('special characters', () => {
    it('keeps quotes and backslashes in the name verbatim', () => {
      expect(script({ name: 'My "Project" \\ Back\\slash' }).name).toBe('My "Project" \\ Back\\slash');
    });

    it('keeps quotes and newlines in the note verbatim', () => {
      expect(script({ note: 'A "quoted" note\nLine 2' }).note).toBe('A "quoted" note\nLine 2');
    });

    it('flattens newlines in the name, as the AppleScript write did', () => {
      expect(script({ name: 'Two\nlines' }).name).toBe('Two lines');
    });
  });

  describe('tags', () => {
    it('sends the tag names', () => {
      expect(script({ tags: ['urgent', 'work'] }).tags).toEqual(['urgent', 'work']);
    });

    it('sends no tags key when tags are empty', () => {
      expect(script({ tags: [] })).not.toHaveProperty('tags');
    });
  });

  describe('sequential flag', () => {
    it('sets sequential to true', () => {
      expect(script({ sequential: true }).sequential).toBe(true);
    });

    it('sets sequential to false by default', () => {
      expect(script().sequential).toBe(false);
    });
  });

  describe('dates', () => {
    it('sends the due date as local wall-clock parts', () => {
      expect(script({ dueDate: '2026-03-20' }).dueDate).toEqual({ y: 2026, m: 3, d: 20, h: 0, mi: 0, s: 0 });
    });

    it('sends the defer date with its time', () => {
      expect(script({ deferDate: '2026-03-15T09:30:00' }).deferDate).toEqual({ y: 2026, m: 3, d: 15, h: 9, mi: 30, s: 0 });
    });

    it('refuses an invalid date before reaching OmniFocus', async () => {
      expect(await addProject(makeParams({ dueDate: 'not-a-date' }))).toEqual({
        success: false,
        error: 'Invalid date string: not-a-date',
      });
      expect(tunnel).not.toHaveBeenCalled();
    });
  });

  describe('other properties', () => {
    it('sets flagged when true', () => {
      expect(script({ flagged: true }).flagged).toBe(true);
    });

    it('does not set flagged when false', () => {
      expect(script({ flagged: false })).not.toHaveProperty('flagged');
    });

    it('sets estimated minutes', () => {
      expect(script({ estimatedMinutes: 45 }).estimatedMinutes).toBe(45);
    });

    it('returns success JSON with project ID', async () => {
      expect(await addProject(makeParams())).toEqual({ success: true, projectId: 'P1' });
    });

    it('passes a script failure through', async () => {
      tunnel.mockResolvedValue({ success: false, error: 'Folder not found: Missing' });
      expect(await addProject(makeParams({ folderName: 'Missing' }))).toEqual({ success: false, error: 'Folder not found: Missing' });
    });
  });

  describe('repeat (#116)', () => {
    it('compiles the repeat for a project', () => {
      expect(script({ repeat: { method: 'fixed', unit: 'month', steps: 3 } }).repeat).toEqual({
        method: 'fixed',
        recurrence: 'FREQ=MONTHLY;INTERVAL=3',
        schedule: 'Regularly',
        anchorKey: null,
        catchUp: false,
        isProject: true,
      });
    });

    it('refuses a planned anchor on a project', async () => {
      const out = await addProject(makeParams({ repeat: { method: 'fixed', unit: 'week', anchor: 'planned' } }));
      expect(out.success).toBe(false);
      expect(out.error).toMatch(/projects have no planned date/);
      expect(tunnel).not.toHaveBeenCalled();
    });
  });
});

describe('addProject.js: what the script does', () => {
  it('creates the project at the root when no folder is specified', () => {
    const { out, w } = run({ name: 'Test Project', sequential: false });
    expect(w.projects.map(p => [p.name, p.parentFolder])).toEqual([['Test Project', null]]);
    expect(out).toEqual({ success: true, projectId: w.projects[0].task.id.primaryKey });
  });

  it('creates the project in a folder named by a single name, case-insensitively', () => {
    const w = buildWorld();
    const work = w.folder('Work');
    run({ name: 'Test Project', sequential: false, folderName: 'work' }, w);
    expect(w.projects[0].parentFolder).toBe(work);
    expect(work.projects.map(p => p.name)).toEqual(['Test Project']);
  });

  it('resolves a nested path by walking the ancestor chain', () => {
    const w = buildWorld();
    const home = w.folder('Home');
    w.folder('Engineering', home);
    const work = w.folder('Work');
    const eng = w.folder('Engineering', work);
    run({ name: 'Test Project', sequential: false, folderName: 'Work/Engineering' }, w);
    expect(w.projects[0].parentFolder).toBe(eng);
  });

  it('fails when the folder is not found, creating nothing', () => {
    const w = buildWorld();
    w.folder('Work');
    expect(run({ name: 'x', sequential: false, folderName: 'Missing' }, w).out).toEqual({
      success: false,
      error: 'Folder not found: Missing',
    });
    expect(run({ name: 'x', sequential: false, folderName: 'Work/Nope' }, w).out).toEqual({
      success: false,
      error: 'Folder not found: Work/Nope',
    });
    expect(w.projects).toHaveLength(0);
  });

  it('errors rather than silently resolving nothing for component-less paths', () => {
    for (const folderName of ['/', '//']) {
      const { out, w } = run({ name: 'x', sequential: false, folderName });
      expect(out).toEqual({ success: false, error: `Folder not found: ${folderName}` });
      expect(w.projects).toHaveLength(0);
    }
  });

  it('writes name and note verbatim, newlines in the note included', () => {
    const name = 'My "Project" \\ `x` ${y}';
    const { w } = run({ name, note: 'Line 1\nLine 2', sequential: false });
    expect(w.projects[0].name).toBe(name);
    expect(w.projects[0].note).toBe('Line 1\nLine 2');
  });

  it('attaches existing tags and creates missing ones', () => {
    const w = buildWorld();
    const urgent = w.tag('urgent');
    run({ name: 'x', sequential: false, tags: ['urgent', 'work'] }, w);
    expect(w.projects[0].tags.map(t => t.name)).toEqual(['urgent', 'work']);
    expect(w.projects[0].tags[0]).toBe(urgent);
    expect(w.tags.map(t => t.name)).toEqual(['urgent', 'work']);
  });

  it('always sets sequential', () => {
    expect(run({ name: 'x', sequential: true }).w.projects[0].sequential).toBe(true);
    expect(run({ name: 'x', sequential: false }).w.projects[0].sequential).toBe(false);
  });

  it('sets dates as local wall-clock times', () => {
    const { w } = run({
      name: 'x', sequential: false,
      dueDate: { y: 2026, m: 3, d: 20, h: 17, mi: 0, s: 0 },
      deferDate: { y: 2026, m: 3, d: 15, h: 0, mi: 0, s: 0 },
    });
    const p = w.projects[0];
    expect([p.dueDate!.getMonth() + 1, p.dueDate!.getDate(), p.dueDate!.getHours()]).toEqual([3, 20, 17]);
    expect([p.deferDate!.getMonth() + 1, p.deferDate!.getDate()]).toEqual([3, 15]);
  });

  it('sets flagged and estimated minutes', () => {
    const p = run({ name: 'x', sequential: false, flagged: true, estimatedMinutes: 45 }).w.projects[0];
    expect(p.flagged).toBe(true);
    expect(p.estimatedMinutes).toBe(45);
  });

  it('reports the root task id, which resolves as a project too (#77)', () => {
    const { out, w } = run({ name: 'x', sequential: false });
    const Project = w.globals.Project as any;
    expect(out.projectId).toBe(w.projects[0].task.id.primaryKey);
    expect(Project.byIdentifier(out.projectId)).toBe(w.projects[0]);
  });

  it('applies the repeat after the dates, so a defaulted anchor sees them', () => {
    const { w } = run({
      name: 'x', sequential: false,
      dueDate: { y: 2026, m: 3, d: 20, h: 0, mi: 0, s: 0 },
      repeat: { method: 'fixed', recurrence: 'FREQ=MONTHLY;INTERVAL=3', schedule: 'Regularly', anchorKey: null, catchUp: false, isProject: true },
    });
    const r = w.projects[0].repetitionRule!;
    expect(r.ruleString).toBe('FREQ=MONTHLY;INTERVAL=3');
    expect(String(r.anchorDateKey)).toBe('DueDate');
    expect(String(r.scheduleType)).toBe('Regularly');
  });

  it('fails loudly when the rule does not read back as written', () => {
    const w = buildWorld();
    w.ruleTamper = r => { if (r) r.ruleString = 'FREQ=DAILY'; };
    const { out } = run({
      name: 'x', sequential: false,
      repeat: { method: 'fixed', recurrence: 'FREQ=WEEKLY', schedule: 'Regularly', anchorKey: 'DueDate', catchUp: false, isProject: true },
    }, w);
    expect(out).toEqual({ success: false, error: 'repetition: rule did not read back as written' });
  });
});
