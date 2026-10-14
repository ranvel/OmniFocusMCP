import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildWorld } from '../../utils/__tests__/omniJsFake.js';
import { runWriteScript } from '../../utils/__tests__/runWriteScript.js';

vi.mock('../../utils/scriptExecution.js', () => ({
  executeOmniFocusWrite: vi.fn(),
}));

import { executeOmniFocusWrite } from '../../utils/scriptExecution.js';
import { addOmniFocusTask, buildAddTaskScriptParams, verifyPersistedWithRetries } from './addOmniFocusTask.js';

const tunnel = vi.mocked(executeOmniFocusWrite);
const created = { success: true, taskId: 'T1', placement: 'inbox' as const };
const run = (params: unknown, w = buildWorld()) => ({ out: runWriteScript('addTask.js', params, w.globals), w });

beforeEach(() => {
  tunnel.mockReset();
  tunnel.mockImplementation(async (script) =>
    script === '@verifyTask.js' ? { success: true, found: true } : created
  );
});

describe('addOmniFocusTask: what the primitive sends', () => {
  it('sends the name alone for an inbox task', async () => {
    await addOmniFocusTask({ name: 'Buy milk' });
    expect(tunnel).toHaveBeenNthCalledWith(1, '@addTask.js', { name: 'Buy milk' });
  });

  it('passes a bare projectName or a folder path through for the script to resolve', () => {
    expect(buildAddTaskScriptParams({ name: 'x', projectName: 'Development' }).projectName).toBe('Development');
    expect(buildAddTaskScriptParams({ name: 'x', projectName: 'Work/Engineering/Backend' }).projectName).toBe('Work/Engineering/Backend');
  });

  it('prefers projectId over projectName when both are supplied', () => {
    const p = buildAddTaskScriptParams({ name: 'x', projectId: 'xyz789', projectName: 'Ambiguous Name' });
    expect(p.projectId).toBe('xyz789');
    expect(p).not.toHaveProperty('projectName');
  });

  it('sends dates as local wall-clock parts and refuses invalid ones', async () => {
    const p = buildAddTaskScriptParams({ name: 'x', dueDate: '2026-03-20', deferDate: '2026-03-15T09:30:00', plannedDate: '2026-03-18' });
    expect(p.dueDate).toEqual({ y: 2026, m: 3, d: 20, h: 0, mi: 0, s: 0 });
    expect(p.deferDate).toEqual({ y: 2026, m: 3, d: 15, h: 9, mi: 30, s: 0 });
    expect(p.plannedDate).toEqual({ y: 2026, m: 3, d: 18, h: 0, mi: 0, s: 0 });
    expect(await addOmniFocusTask({ name: 'x', dueDate: 'nope' })).toEqual({ success: false, error: 'Invalid date string: nope' });
    expect(tunnel).not.toHaveBeenCalled();
  });

  it('keeps the note verbatim, newlines included, and flattens the name', () => {
    const p = buildAddTaskScriptParams({ name: 'A\ntask', note: 'Line 1\nLine 2\nLine 3' });
    expect(p.name).toBe('A task');
    expect(p.note).toBe('Line 1\nLine 2\nLine 3');
  });

  it('sends flagged only when true, and the other properties as given', () => {
    expect(buildAddTaskScriptParams({ name: 'x', flagged: false })).not.toHaveProperty('flagged');
    const p = buildAddTaskScriptParams({ name: 'x', flagged: true, estimatedMinutes: 30, tags: ['a', 'b'], parentTaskId: 'task-99', parentTaskName: 'Parent' });
    expect(p).toMatchObject({ flagged: true, estimatedMinutes: 30, tags: ['a', 'b'], parentTaskId: 'task-99', parentTaskName: 'Parent' });
  });

  it('compiles the repeat for a task and refuses a malformed one', async () => {
    expect(buildAddTaskScriptParams({ name: 'x', repeat: { method: 'start-after-completion', unit: 'week' } }).repeat).toEqual({
      method: 'start-after-completion', recurrence: 'FREQ=WEEKLY', schedule: 'FromCompletion', anchorKey: 'DeferDate', catchUp: false, isProject: false,
    });
    const out = await addOmniFocusTask({ name: 'Bad', repeat: { method: 'fixed', unit: 'week', steps: 0 } as any });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/Invalid repeat steps/);
  });

  it('returns the id and placement the script reports', async () => {
    expect(await addOmniFocusTask({ name: 'Buy milk' })).toEqual({ success: true, taskId: 'T1', placement: 'inbox' });
  });

  it('passes a script failure through', async () => {
    tunnel.mockResolvedValue({ success: false, error: 'Project not found: id abc123' });
    expect(await addOmniFocusTask({ name: 'x', projectId: 'abc123' })).toEqual({ success: false, error: 'Project not found: id abc123' });
  });
});

describe('addOmniFocusTask: persistence guard (#57)', () => {
  it('verifies the new id in a separate call before reporting success', async () => {
    await addOmniFocusTask({ name: 'x' });
    expect(tunnel).toHaveBeenNthCalledWith(2, '@verifyTask.js', { id: 'T1' });
  });

  it('retries the probe until the task resolves', async () => {
    let probes = 0;
    tunnel.mockImplementation(async (script) => {
      if (script !== '@verifyTask.js') return created;
      probes++;
      return { success: true, found: probes >= 3 };
    });
    expect(await addOmniFocusTask({ name: 'x' })).toEqual({ success: true, taskId: 'T1', placement: 'inbox' });
    expect(probes).toBe(3);
  });

  it('reports an honest failure, keeping the id, when the task never resolves', async () => {
    tunnel.mockImplementation(async (script) =>
      script === '@verifyTask.js' ? { success: false, error: 'boom' } : { ...created, placement: 'project' }
    );
    expect(await addOmniFocusTask({ name: 'Ghost' })).toEqual({
      success: false,
      taskId: 'T1',
      placement: 'project',
      error: 'Task "Ghost" was created but could not be confirmed in OmniFocus after retries; it may not have persisted. Please retry.',
    });
  });
});

describe('addTask.js: what the script does', () => {
  it('creates inbox task when no project specified', () => {
    const { out, w } = run({ name: 'Buy milk' });
    expect(out).toEqual({ success: true, taskId: w.inboxList[0].id.primaryKey, placement: 'inbox' });
    expect(w.inboxList[0].name).toBe('Buy milk');
  });

  it('creates task in project when bare projectName specified', () => {
    const w = buildWorld();
    const P = w.project('Development');
    const { out } = run({ name: 'Write tests', projectName: 'development' }, w);
    expect(out.placement).toBe('project');
    expect(w.names(P)).toEqual([out.taskId]);
  });

  it('resolves folder-path projectName via folder ancestry walk', () => {
    const w = buildWorld();
    const work = w.folder('Work');
    const eng = w.folder('Engineering', work);
    w.project('Backend', w.folder('Engineering', w.folder('Home')));
    const backend = w.project('Backend', eng);
    const { out } = run({ name: 'Task in nested project', projectName: 'Work/Engineering/Backend' }, w);
    expect(out.placement).toBe('project');
    expect(w.names(backend)).toEqual([out.taskId]);
  });

  it('keeps quotes in folder-path components', () => {
    const w = buildWorld();
    const P = w.project('My Project', w.folder('Quotes "are" hard'));
    const { out } = run({ name: 'Quoted', projectName: 'Quotes "are" hard/My Project' }, w);
    expect(w.names(P)).toEqual([out.taskId]);
  });

  it('fails when the project is not found, creating nothing', () => {
    const { out, w } = run({ name: 'x', projectName: 'Nope' });
    expect(out).toEqual({ success: false, error: 'Project not found: Nope' });
    expect(w.tasks).toHaveLength(0);
  });

  it('errors rather than silently landing in the inbox for a component-less path', () => {
    const { out, w } = run({ name: 'x', projectName: '/' });
    expect(out).toEqual({ success: false, error: 'Project not found: /' });
    expect(w.tasks).toHaveLength(0);
  });

  it('resolves project by id when projectId specified, by either id form (#77)', () => {
    const w = buildWorld();
    const P = w.project('Development', null, 'abc123');
    expect(run({ name: 'By project id', projectId: 'abc123' }, w).out.placement).toBe('project');
    expect(run({ name: 'By root task id', projectId: P.task.id.primaryKey }, w).out.placement).toBe('project');
    expect(w.names(P).length).toBe(2);
    expect(run({ name: 'x', projectId: 'missing' }, w).out).toEqual({ success: false, error: 'Project not found: id missing' });
  });

  it('preserves newlines in the note', () => {
    const { w } = run({ name: 'A task', note: 'Line 1\nLine 2\nLine 3' });
    expect(w.inboxList[0].note).toBe('Line 1\nLine 2\nLine 3');
  });

  it('nests under a parent task by id and reports placement parent', () => {
    const w = buildWorld();
    const P = w.project('Dev', null, 'proj-1');
    const parent = w.task('Epic', P, 'task-99');
    const { out } = run({ name: 'Child task', projectId: 'proj-1', parentTaskId: 'task-99' }, w);
    expect(out.placement).toBe('parent');
    expect(w.names(parent)).toEqual([out.taskId]);
  });

  it('nests under an inbox task by id', () => {
    const w = buildWorld();
    const parent = w.task('Inbox parent', null, 'I1');
    const { out } = run({ name: 'Child', parentTaskId: 'I1' }, w);
    expect(out.placement).toBe('parent');
    expect(w.names(parent)).toEqual([out.taskId]);
  });

  it('parent-within-project constraint: a parent in another project is ignored', () => {
    const w = buildWorld();
    const P1 = w.project('One', null, 'proj-1');
    const P2 = w.project('Two', null, 'proj-2');
    w.task('Elsewhere', P2, 'task-99');
    const { out } = run({ name: 'Child task', projectId: 'proj-1', parentTaskId: 'task-99' }, w);
    expect(out.placement).toBe('project');
    expect(w.names(P1)).toEqual([out.taskId]);
  });

  it('finds a parent by name inside the target project before anywhere else', () => {
    const w = buildWorld();
    const P1 = w.project('One');
    const P2 = w.project('Two');
    w.task('Epic', P1, 'E1');
    const epic2 = w.task('Epic', P2, 'E2');
    const { out } = run({ name: 'Child', projectName: 'Two', parentTaskName: 'Epic' }, w);
    expect(out.placement).toBe('parent');
    expect(w.names(epic2)).toEqual([out.taskId]);
  });

  it('with no project, a parent name matches anywhere, inbox included', () => {
    const w = buildWorld();
    const inboxParent = w.task('Epic', null, 'I1');
    const { out } = run({ name: 'Child', parentTaskName: 'epic' }, w);
    expect(out.placement).toBe('parent');
    expect(w.names(inboxParent)).toEqual([out.taskId]);
  });

  it('falls back to the project when the named parent is not in it', () => {
    const w = buildWorld();
    const P1 = w.project('One');
    const P2 = w.project('Two');
    w.task('Epic', P2);
    const { out } = run({ name: 'Child', projectName: 'One', parentTaskName: 'Epic' }, w);
    expect(out.placement).toBe('project');
    expect(w.names(P1)).toEqual([out.taskId]);
  });

  it('sets properties, dates and tags', () => {
    const w = buildWorld();
    const urgent = w.tag('urgent');
    const { w: world } = run({
      name: 'x', flagged: true, estimatedMinutes: 25, tags: ['urgent', 'new'],
      dueDate: { y: 2026, m: 11, d: 1, h: 17, mi: 0, s: 0 },
      deferDate: { y: 2026, m: 10, d: 20, h: 0, mi: 0, s: 0 },
      plannedDate: { y: 2026, m: 10, d: 25, h: 0, mi: 0, s: 0 },
    }, w);
    const t = world.inboxList[0];
    expect(t.flagged).toBe(true);
    expect(t.estimatedMinutes).toBe(25);
    expect(t.tags.map(x => x.name)).toEqual(['urgent', 'new']);
    expect(t.tags[0]).toBe(urgent);
    expect([t.dueDate!.getMonth() + 1, t.dueDate!.getDate(), t.dueDate!.getHours()]).toEqual([11, 1, 17]);
    expect([t.deferDate!.getMonth() + 1, t.deferDate!.getDate()]).toEqual([10, 20]);
    expect([t.plannedDate!.getMonth() + 1, t.plannedDate!.getDate()]).toEqual([10, 25]);
  });

  it('applies the repeat after the dates, so a defaulted anchor sees them (#116)', () => {
    const { w } = run({
      name: 'Fri review',
      deferDate: { y: 2026, m: 10, d: 2, h: 0, mi: 0, s: 0 },
      dueDate: { y: 2026, m: 10, d: 9, h: 0, mi: 0, s: 0 },
      repeat: { method: 'fixed', recurrence: 'FREQ=WEEKLY;BYDAY=FR', schedule: 'Regularly', anchorKey: null, catchUp: false, isProject: false },
    });
    const r = w.inboxList[0].repetitionRule!;
    expect(r.ruleString).toBe('FREQ=WEEKLY;BYDAY=FR');
    expect(String(r.anchorDateKey)).toBe('DueDate');
  });

  it('keeps a hostile name verbatim and does not echo it (#103)', () => {
    const name = 'retitle to "policy \\ infrastructure" `engineer` ${x}';
    const { out, w } = run({ name });
    expect(out.success).toBe(true);
    expect(JSON.stringify(out)).not.toContain('policy');
    expect(w.inboxList[0].name).toBe(name);
  });
});

describe('verifyPersistedWithRetries (issue #57 persistence guard)', () => {
  const noSleep = () => Promise.resolve();

  it('returns true on the first successful probe without sleeping', async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const sleepFn = vi.fn(noSleep);
    const ok = await verifyPersistedWithRetries(probe, { sleepFn });
    expect(ok).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('retries until a later probe succeeds, then stops', async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const ok = await verifyPersistedWithRetries(probe, {
      delaysMs: [0, 10, 20, 40],
      sleepFn: noSleep,
    });
    expect(ok).toBe(true);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('returns false when the task never becomes resolvable', async () => {
    const probe = vi.fn().mockResolvedValue(false);
    const ok = await verifyPersistedWithRetries(probe, {
      delaysMs: [0, 10, 20],
      sleepFn: noSleep,
    });
    expect(ok).toBe(false);
    expect(probe).toHaveBeenCalledTimes(3);
  });
});
