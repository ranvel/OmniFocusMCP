import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildWorld, RepetitionRule, type FakeTask } from '../../utils/__tests__/omniJsFake.js';
import { runWriteScript } from '../../utils/__tests__/runWriteScript.js';

vi.mock('../../utils/scriptExecution.js', () => ({
  executeOmniFocusWrite: vi.fn(async () => ({ success: true, id: 'abc', name: 'Test Task', changedProperties: 'name' })),
}));

import { executeOmniFocusWrite } from '../../utils/scriptExecution.js';
import { editItem, buildEditItemScriptParams, EditItemParamError, type EditItemParams } from './editItem.js';

const tunnel = vi.mocked(executeOmniFocusWrite);
const makeParams = (overrides: Partial<EditItemParams>): EditItemParams => ({ itemType: 'task', name: 'Test Task', ...overrides });
const script = (overrides: Partial<EditItemParams>) => buildEditItemScriptParams(makeParams(overrides));
const weekly = () => new RepetitionRule('FREQ=WEEKLY', null, 'Regularly', 'DueDate', false);

/** A world with a task T in project P (folder Work) and an inbox task I. */
function world() {
  const w = buildWorld();
  const work = w.folder('Work');
  const P = w.project('Project', work, 'P');
  const T = w.task('Test Task', P, 'abc');
  const I = w.task('Inbox Task', null, 'I');
  const run = (params: Record<string, unknown>) =>
    runWriteScript('editItem.js', { itemType: 'task', id: 'abc', allowPastOccurrence: false, ...params }, w.globals);
  return { w, work, P, T, I, run };
}

beforeEach(() => {
  tunnel.mockClear();
  tunnel.mockResolvedValue({ success: true, id: 'abc', name: 'Test Task', changedProperties: 'name' });
});

describe('editItem: what the primitive sends', () => {
  it('sends selectors and the past-occurrence opt-in', () => {
    expect(script({ id: 'abc123', newName: 'x' })).toEqual({
      itemType: 'task', id: 'abc123', name: 'Test Task', allowPastOccurrence: false, newName: 'x',
    });
    expect(script({ allowPastOccurrence: true, newName: 'x' }).allowPastOccurrence).toBe(true);
  });

  it('returns error when neither id nor name provided, without reaching OmniFocus', async () => {
    expect(await editItem({ itemType: 'task', newName: 'x' })).toEqual({ success: false, error: 'Either id or name must be provided' });
    expect(tunnel).not.toHaveBeenCalled();
  });

  describe('common properties', () => {
    it('sends name, note, flagged and estimated minutes', () => {
      expect(script({ newName: 'Updated Name', newNote: 'A note', newFlagged: true, newEstimatedMinutes: 30 })).toMatchObject({
        newName: 'Updated Name', newNote: 'A note', newFlagged: true, newEstimatedMinutes: 30,
      });
    });

    it('preserves newlines, CRLF and quotes in the note; flattens them in the name', () => {
      expect(script({ newNote: 'He said "hi"\nthen left\r\nb\rc' }).newNote).toBe('He said "hi"\nthen left\r\nb\rc');
      expect(script({ newName: 'Two\nlines' }).newName).toBe('Two lines');
    });

    it('sends dates as parts, "" as null, and leaves absent dates out', () => {
      const p = script({ newDueDate: '2026-03-20T17:00:00', newDeferDate: '' });
      expect(p.newDueDate).toEqual({ y: 2026, m: 3, d: 20, h: 17, mi: 0, s: 0 });
      expect(p.newDeferDate).toBeNull();
      expect(p).not.toHaveProperty('newPlannedDate');
    });

    it('refuses an invalid date before reaching OmniFocus', async () => {
      expect(await editItem(makeParams({ newDueDate: 'nope' }))).toEqual({ success: false, error: 'Invalid date string: nope' });
      expect(tunnel).not.toHaveBeenCalled();
    });

    it('distinguishes a false flag from an absent one', () => {
      expect(script({ newFlagged: false }).newFlagged).toBe(false);
      expect(script({ newName: 'x' })).not.toHaveProperty('newFlagged');
    });
  });

  describe('repetition (#116)', () => {
    it('compiles a new rule for the item type', () => {
      expect(script({ newRepeat: { method: 'due-after-completion', unit: 'day', steps: 5 } }).newRepeat).toEqual({
        method: 'due-after-completion', recurrence: 'FREQ=DAILY;INTERVAL=5', schedule: 'FromCompletion', anchorKey: 'DueDate', catchUp: false, isProject: false,
      });
      expect(buildEditItemScriptParams({ itemType: 'project', id: 'p1', newRepeat: { method: 'fixed', unit: 'year' } }).newRepeat).toMatchObject({ isProject: true });
    });

    it('sends null to clear and nothing when unspecified', () => {
      expect(script({ newRepeat: null }).newRepeat).toBeNull();
      expect(script({ newName: 'Renamed' })).not.toHaveProperty('newRepeat');
    });
  });

  describe('tag operations', () => {
    it('sends add and remove lists', () => {
      expect(script({ addTags: ['urgent', 'review'], removeTags: ['old-tag'] })).toMatchObject({ addTags: ['urgent', 'review'], removeTags: ['old-tag'] });
    });

    it('replace wins over add and remove', () => {
      const p = script({ replaceTags: ['new-tag'], addTags: ['a'], removeTags: ['b'] });
      expect(p.replaceTags).toEqual(['new-tag']);
      expect(p).not.toHaveProperty('addTags');
      expect(p).not.toHaveProperty('removeTags');
    });

    it('an empty replace list falls through to add/remove, as before', () => {
      const p = script({ replaceTags: [], addTags: ['a'] });
      expect(p).not.toHaveProperty('replaceTags');
      expect(p.addTags).toEqual(['a']);
    });
  });

  describe('task-specific fields', () => {
    it('sends the status and the destination project verbatim', () => {
      expect(script({ newStatus: 'dropped', newProjectName: 'Work/Community Outreach' })).toMatchObject({
        newStatus: 'dropped', newProjectName: 'Work/Community Outreach',
      });
      expect(script({ newProjectName: '' }).newProjectName).toBe('');
    });

    it('packs newParentTaskId and position into one move', () => {
      expect(script({ newParentTaskId: 'P9' }).move).toEqual({ parentId: 'P9' });
      expect(script({ newParentTaskId: '', position: { after: 'B' } }).move).toEqual({ parentId: '', position: { after: 'B' } });
      expect(script({ position: 'beginning' }).move).toEqual({ position: 'beginning' });
      expect(script({ newName: 'x' })).not.toHaveProperty('move');
    });
  });

  describe('project-specific fields', () => {
    const proj = (fields: Partial<EditItemParams>) => buildEditItemScriptParams({ itemType: 'project', name: 'P', ...fields });

    it('sends sequential, status and folder', () => {
      expect(proj({ newSequential: true, newProjectStatus: 'onHold', newFolderName: 'Work/Engineering' })).toMatchObject({
        newSequential: true, newProjectStatus: 'onHold', newFolderName: 'Work/Engineering',
      });
    });

    it('an empty folder name is not a move', () => {
      expect(proj({ newFolderName: '' })).not.toHaveProperty('newFolderName');
    });

    it('sends markReviewed only when true', () => {
      expect(proj({ markReviewed: true }).markReviewed).toBe(true);
      expect(proj({ markReviewed: false })).not.toHaveProperty('markReviewed');
    });

    it('compiles the review interval and labels it as query_omnifocus reads it back (#139)', () => {
      expect(proj({ newReviewInterval: { steps: 2, unit: 'week' } })).toMatchObject({
        newReviewInterval: { steps: 2, unit: 'weeks' },
        reviewIntervalLabel: '2 weeks',
      });
      expect(proj({ newReviewInterval: { steps: 1, unit: 'month' } }).reviewIntervalLabel).toBe('1 month');
    });
  });

  describe('refused combinations (#138 / #139)', () => {
    it('refuses newParentTaskId together with newProjectName', () => {
      expect(() => script({ id: 'T1', newParentTaskId: 'P9', newProjectName: 'Work' })).toThrow(/not both/);
    });

    it.each([
      [{ newParentTaskId: 'P9' }],
      [{ newParentTaskId: '' }],
      [{ position: 'beginning' as const }],
    ])('refuses %o on a project', fields => {
      expect(() => buildEditItemScriptParams({ itemType: 'project', id: 'X', ...fields })).toThrow(/tasks only/);
      expect(() => buildEditItemScriptParams({ itemType: 'project', id: 'X', ...fields })).toThrow(EditItemParamError);
    });

    it('refuses newReviewInterval on a task', () => {
      expect(() => script({ newReviewInterval: { steps: 1, unit: 'week' } })).toThrow(/projects only/);
    });

    it('reports a refusal as a failed result, never reaching OmniFocus', async () => {
      const out = await editItem({ id: 'x', itemType: 'project', position: 'end' });
      expect(out.success).toBe(false);
      expect(out.error).toMatch(/tasks only/);
      expect(tunnel).not.toHaveBeenCalled();
    });
  });

  it('returns what the script reports', async () => {
    tunnel.mockResolvedValue({ success: true, id: 'abc', name: 'Old', changedProperties: 'name, flagged' });
    expect(await editItem(makeParams({ id: 'abc', newName: 'New', newFlagged: true }))).toEqual({
      success: true, id: 'abc', name: 'Old', changedProperties: 'name, flagged',
    });
    tunnel.mockResolvedValue({ success: false, error: 'move: task not found' });
    expect(await editItem(makeParams({ id: 'abc', position: 'end' }))).toEqual({ success: false, error: 'move: task not found' });
  });
});

describe('editItem.js: what the script does', () => {
  describe('item lookup', () => {
    it('searches by id when provided', () => {
      const { run } = world();
      expect(run({ id: 'abc', newName: 'x' })).toMatchObject({ success: true, id: 'abc', name: 'Test Task' });
    });

    it('searches by name when no id, case-insensitively', () => {
      const { run } = world();
      expect(run({ id: undefined, name: 'test task', newName: 'x' })).toMatchObject({ success: true, id: 'abc' });
    });

    it('falls back to the name when the id does not resolve', () => {
      const { run } = world();
      expect(run({ id: 'stale', name: 'Test Task', newName: 'x' })).toMatchObject({ success: true, id: 'abc' });
    });

    it('reports Item not found', () => {
      const { run } = world();
      expect(run({ id: 'nope', name: 'nothing', newName: 'x' })).toEqual({ success: false, error: 'Item not found' });
    });

    it('finds a project by its id or root task id (#77)', () => {
      const { w } = world();
      const out = runWriteScript('editItem.js', { itemType: 'project', id: 'P', allowPastOccurrence: false, newSequential: true }, w.globals);
      expect(out).toEqual({ success: true, id: 'P', name: 'Project', changedProperties: 'sequential' });
    });

    it('reports the name the caller targeted, even after a rename', () => {
      const { run, T } = world();
      expect(run({ newName: 'Updated Name' })).toEqual({ success: true, id: 'abc', name: 'Test Task', changedProperties: 'name' });
      expect(T.name).toBe('Updated Name');
    });
  });

  describe('common properties', () => {
    it('applies name, note, dates, flagged and estimated minutes, labelling each in order', () => {
      const { run, T } = world();
      const out = run({
        newName: 'Updated Name', newNote: 'Line 1\nLine 2', newDueDate: { y: 2026, m: 11, d: 1, h: 17, mi: 0, s: 0 },
        newDeferDate: { y: 2026, m: 10, d: 20, h: 0, mi: 0, s: 0 }, newPlannedDate: null, newFlagged: true, newEstimatedMinutes: 30,
      });
      expect(out.changedProperties).toBe('name, note, due date, defer date, planned date, flagged, estimated minutes');
      expect(T.name).toBe('Updated Name');
      expect(T.note).toBe('Line 1\nLine 2');
      expect([T.dueDate!.getMonth() + 1, T.dueDate!.getDate(), T.dueDate!.getHours()]).toEqual([11, 1, 17]);
      expect(T.deferDate!.getDate()).toBe(20);
      expect(T.plannedDate).toBeNull();
      expect(T.flagged).toBe(true);
      expect(T.estimatedMinutes).toBe(30);
    });

    it('clears a date with null', () => {
      const { run, T } = world();
      T.dueDate = new Date();
      run({ newDueDate: null });
      expect(T.dueDate).toBeNull();
    });

    it('keeps a hostile name and note verbatim in the item and the result (#103)', () => {
      const { run, T } = world();
      const name = 'retitle to "policy \\ infrastructure" `engineer` ${x}';
      T.name = name;
      const out = run({ newNote: 'He said "hi"' });
      expect(out).toEqual({ success: true, id: 'abc', name, changedProperties: 'note' });
      expect(T.note).toBe('He said "hi"');
    });
  });

  describe('repetition (#116)', () => {
    it('sets a new rule after the date edits and labels what was stored', () => {
      const { run, T } = world();
      const out = run({
        newDeferDate: { y: 2026, m: 10, d: 2, h: 0, mi: 0, s: 0 }, newDueDate: null,
        newRepeat: { method: 'fixed', recurrence: 'FREQ=WEEKLY', schedule: 'Regularly', anchorKey: null, catchUp: false, isProject: false },
      });
      expect(out.changedProperties).toBe('due date, defer date, repetition (fixed, from defer date)');
      expect(T.repetitionRule!.ruleString).toBe('FREQ=WEEKLY');
    });

    it('labels after-completion rules statically', () => {
      const { run } = world();
      expect(run({ newRepeat: { method: 'due-after-completion', recurrence: 'FREQ=DAILY;INTERVAL=5', schedule: 'FromCompletion', anchorKey: 'DueDate', catchUp: false, isProject: false } }).changedProperties)
        .toBe('repetition (due after completion)');
    });

    it('clears the rule when newRepeat is null', () => {
      const { run, T } = world();
      T.repetitionRule = weekly();
      expect(run({ newRepeat: null }).changedProperties).toBe('repetition (cleared)');
      expect(T.repetitionRule).toBeNull();
    });

    it('leaves the rule alone when newRepeat is absent', () => {
      const { run, T } = world();
      T.repetitionRule = weekly();
      run({ newName: 'Renamed' });
      expect(T.repetitionRule).not.toBeNull();
    });

    it('works on projects as well as tasks', () => {
      const { w, P } = world();
      const out = runWriteScript('editItem.js', {
        itemType: 'project', id: 'P', allowPastOccurrence: false,
        newRepeat: { method: 'fixed', recurrence: 'FREQ=YEARLY', schedule: 'Regularly', anchorKey: null, catchUp: false, isProject: true },
      }, w.globals);
      expect(out.changedProperties).toBe('repetition (fixed, from defer date)');
      expect(P.repetitionRule!.ruleString).toBe('FREQ=YEARLY');
    });
  });

  describe('tag operations', () => {
    it('adds tags, creating missing ones', () => {
      const { run, T, w } = world();
      const urgent = w.tag('urgent');
      expect(run({ addTags: ['urgent', 'review'] }).changedProperties).toBe('tags (added)');
      expect(T.tags.map(t => t.name)).toEqual(['urgent', 'review']);
      expect(T.tags[0]).toBe(urgent);
    });

    it('removes tags, ignoring names that match nothing', () => {
      const { run, T, w } = world();
      const old = w.tag('old-tag');
      const keep = w.tag('keep');
      T.addTags([old, keep]);
      expect(run({ removeTags: ['old-tag', 'nope'] }).changedProperties).toBe('tags (removed)');
      expect(T.tags).toEqual([keep]);
    });

    it('replaces all tags', () => {
      const { run, T, w } = world();
      T.addTag(w.tag('old'));
      expect(run({ replaceTags: ['new-tag'] }).changedProperties).toBe('tags (replaced)');
      expect(T.tags.map(t => t.name)).toEqual(['new-tag']);
    });

    it('adds and removes in one call, labelled in order', () => {
      const { run, T, w } = world();
      T.addTag(w.tag('old'));
      expect(run({ addTags: ['new'], removeTags: ['old'] }).changedProperties).toBe('tags (added), tags (removed)');
      expect(T.tags.map(t => t.name)).toEqual(['new']);
    });

    // Regression: #64 — addTags on a project was a silent no-op because tag
    // handling was nested inside the task-only block.
    it('adds, removes and replaces tags on projects too (#64)', () => {
      const { w, P } = world();
      const proj = (fields: Record<string, unknown>) =>
        runWriteScript('editItem.js', { itemType: 'project', id: 'P', allowPastOccurrence: false, ...fields }, w.globals);
      expect(proj({ addTags: ['zzTestTag'] }).changedProperties).toBe('tags (added)');
      expect(P.tags.map(t => t.name)).toEqual(['zzTestTag']);
      expect(proj({ replaceTags: ['new-tag'] }).changedProperties).toBe('tags (replaced)');
      expect(P.tags.map(t => t.name)).toEqual(['new-tag']);
      expect(proj({ removeTags: ['new-tag'] }).changedProperties).toBe('tags (removed)');
      expect(P.tags).toEqual([]);
    });
  });

  describe('newStatus — task status changes', () => {
    it('marks complete, then incomplete', () => {
      const { run, T } = world();
      expect(run({ newStatus: 'completed' }).changedProperties).toBe('status (completed)');
      expect(T.completed).toBe(true);
      expect(run({ newStatus: 'incomplete' }).changedProperties).toBe('status (incomplete)');
      expect(T.completed).toBe(false);
    });

    it('drops this occurrence only, as mark dropped did', () => {
      const { run, T } = world();
      expect(run({ newStatus: 'dropped' }).changedProperties).toBe('status (dropped)');
      expect(T.dropDate).not.toBeNull();
    });

    it('dropping a repeating task resolves this occurrence and keeps the chain live', () => {
      const { run, T, w } = world();
      T.repetitionRule = weekly();
      run({ newStatus: 'dropped' });
      expect(T.dropDate).toBeNull();
      expect(w.tasks.filter(t => t.name === 'Test Task' && t.dropDate)).toHaveLength(1);
    });

    it('skips a repeating task: this occurrence dropped, the live one advances', () => {
      const { run, T, w } = world();
      T.repetitionRule = weekly();
      const out = run({ newStatus: 'skipped' });
      expect(out).toMatchObject({ success: true, id: 'abc', changedProperties: 'status (skipped)' });
      expect(T.dropDate).toBeNull();
      expect(T.completed).toBe(false);
      const occurrences = w.tasks.filter(t => t.name === 'Test Task' && t !== T);
      expect(occurrences).toHaveLength(1);
      expect(occurrences[0].dropDate).not.toBeNull();
      expect(occurrences[0].completed).toBe(false);
    });

    it('refuses to skip a non-repeating task', () => {
      const { run, T } = world();
      expect(run({ newStatus: 'skipped' })).toEqual({
        success: false,
        error: 'Cannot skip a non-repeating task. The task must have a repetition rule.',
      });
      expect(T.dropDate).toBeNull();
    });

    it('ignores newStatus on a project (task-only field)', () => {
      const { w, P } = world();
      const out = runWriteScript('editItem.js', { itemType: 'project', id: 'P', allowPastOccurrence: false, newStatus: 'completed', newName: 'x' }, w.globals);
      expect(out.changedProperties).toBe('name');
      expect(P.completed).toBe(false);
    });
  });

  describe('newProjectName — move task between projects', () => {
    it('moves to a named project, at the end', () => {
      const { run, w, T } = world();
      const marketing = w.project('Marketing');
      w.task('Existing', marketing);
      expect(run({ newProjectName: 'Marketing' }).changedProperties).toBe('project (moved to Marketing)');
      expect(w.names(marketing)).toEqual([w.names(marketing)[0], 'abc']);
      expect(T.containingProject).toBe(marketing);
    });

    it('moves to the inbox when newProjectName is empty string', () => {
      const { run, T } = world();
      expect(run({ newProjectName: '' }).changedProperties).toBe('project (moved to inbox)');
      expect(T.inInbox).toBe(true);
    });

    it.each(['inbox', 'Inbox', 'INBOX'])('moves to the inbox when newProjectName is %s', name => {
      const { run, T } = world();
      expect(run({ newProjectName: name }).changedProperties).toBe('project (moved to inbox)');
      expect(T.inInbox).toBe(true);
    });

    it('resolves a folder-qualified project path', () => {
      const { run, w, T } = world();
      w.project('Community Outreach', null);
      const personal = w.folder('Personal');
      const committees = w.folder('Committees', personal);
      const target = w.project('Community Outreach', committees);
      expect(run({ newProjectName: 'Personal/Committees/Community Outreach' }).changedProperties)
        .toBe('project (moved to Personal/Committees/Community Outreach)');
      expect(T.containingProject).toBe(target);
    });

    it('keeps special characters in the project name and the label', () => {
      const { run, w, T } = world();
      const q = w.project('My "Project"');
      expect(run({ newProjectName: 'My "Project"' }).changedProperties).toBe('project (moved to My "Project")');
      expect(T.containingProject).toBe(q);
    });

    it('fails when the destination does not exist, moving nothing', () => {
      const { run, T, P } = world();
      expect(run({ newProjectName: 'Nope' })).toEqual({ success: false, error: 'Project not found: Nope' });
      expect(T.containingProject).toBe(P);
    });

    it('does not move a project (task-only field)', () => {
      const { w } = world();
      w.project('Other');
      const out = runWriteScript('editItem.js', { itemType: 'project', id: 'P', allowPastOccurrence: false, newProjectName: 'Other', newName: 'x' }, w.globals);
      expect(out.changedProperties).toBe('name');
    });
  });

  describe('newParentTaskId / position (#138)', () => {
    it('nests under a parent and labels it', () => {
      const { run, w, P, T } = world();
      const parent = w.task('Parent', P, 'P9');
      expect(run({ move: { parentId: 'P9' } }).changedProperties).toBe('parent (moved under Parent)');
      expect(T.parent).toBe(parent);
    });

    it('combines the parent and position labels', () => {
      const { run, w, P } = world();
      const parent = w.task('Parent', P, 'P9');
      const sib = w.task('Sib', parent, 'S');
      expect(run({ move: { parentId: 'P9', position: { before: 'S' } } }).changedProperties).toBe('parent (moved under Parent), position (before S)');
      expect(w.names(parent)).toEqual(['abc', 'S']);
      expect(sib.parent).toBe(parent);
    });

    it('places a position-only reorder after a newProjectName move', () => {
      const { run, w, T } = world();
      const marketing = w.project('Marketing');
      w.task('Existing', marketing, 'E');
      expect(run({ newProjectName: 'Marketing', move: { position: 'beginning' } }).changedProperties)
        .toBe('project (moved to Marketing), position (beginning)');
      expect(w.names(marketing)).toEqual(['abc', 'E']);
      expect(T.containingProject).toBe(marketing);
    });

    it('surfaces move refusals as failures with their exact message', () => {
      const { run } = world();
      expect(run({ move: { parentId: 'nope' } })).toEqual({ success: false, error: 'move: parent task not found: nope' });
      expect(run({ move: { parentId: 'abc' } })).toEqual({ success: false, error: 'move: cannot nest a task under itself or one of its own subtasks' });
    });

    it('applies the move after the #124 guard', () => {
      const { run, T, w } = world();
      T.repetitionRule = weekly();
      const done = T.markComplete();
      const out = run({ id: done.id.primaryKey, move: { position: 'beginning' } });
      expect(out.success).toBe(false);
      expect(out.error).toMatch(/completed occurrence/);
      expect(w.names(w.projects[0])).toEqual([done.id.primaryKey, 'abc']);
    });
  });

  describe('project-specific fields', () => {
    const proj = (w: ReturnType<typeof world>['w'], fields: Record<string, unknown>) =>
      runWriteScript('editItem.js', { itemType: 'project', id: 'P', allowPastOccurrence: false, ...fields }, w.globals);

    it('sets sequential', () => {
      const { w, P } = world();
      expect(proj(w, { newSequential: true }).changedProperties).toBe('sequential');
      expect(P.sequential).toBe(true);
    });

    it('changes status: onHold, active, completed, dropped', () => {
      const { w, P } = world();
      expect(proj(w, { newProjectStatus: 'onHold' }).changedProperties).toBe('status (onHold)');
      expect(String(P.status)).toBe('OnHold');
      expect(proj(w, { newProjectStatus: 'active' }).changedProperties).toBe('status (active)');
      expect(String(P.status)).toBe('Active');
      expect(proj(w, { newProjectStatus: 'completed' }).changedProperties).toBe('status (completed)');
      expect(String(P.status)).toBe('Done');
      proj(w, { newProjectStatus: 'active' });
      expect(proj(w, { newProjectStatus: 'dropped' }).changedProperties).toBe('status (dropped)');
      expect(String(P.status)).toBe('Dropped');
    });

    it('sets the review interval, labelled as query_omnifocus reads it back (#139)', () => {
      const { w, P } = world();
      expect(proj(w, { newReviewInterval: { steps: 2, unit: 'weeks' }, reviewIntervalLabel: '2 weeks' }).changedProperties)
        .toBe('review interval (every 2 weeks)');
      expect(P.reviewInterval).toMatchObject({ steps: 2, unit: 'weeks' });
    });

    it('sets the interval before markReviewed, so the next review uses it', () => {
      const { w, P } = world();
      const out = proj(w, { markReviewed: true, newReviewInterval: { steps: 1, unit: 'months' }, reviewIntervalLabel: '1 month' });
      expect(out.changedProperties).toBe('review interval (every 1 month), marked reviewed');
      expect(P.reviewInterval.unit).toBe('months');
      expect(P.lastReviewDate).not.toBeNull();
      expect(P.nextReviewDate).toBeNull();
    });

    it('does not mark reviewed for tasks (project-only field)', () => {
      const { run } = world();
      expect(run({ markReviewed: true, newName: 'x' }).changedProperties).toBe('name');
    });

    it('moves the project to a folder by name or nested path', () => {
      const { w, P } = world();
      const eng = w.folder('Engineering', w.folder('Work2'));
      expect(proj(w, { newFolderName: 'Work2/Engineering' }).changedProperties).toBe('folder');
      expect(P.parentFolder).toBe(eng);
      expect(eng.projects).toEqual([P]);
    });

    it('fails when the folder does not exist', () => {
      const { w, P, work } = world();
      expect(proj(w, { newFolderName: 'Missing' })).toEqual({ success: false, error: 'Folder not found: Missing' });
      expect(P.parentFolder).toBe(work);
    });

    it('surfaces a review interval that did not land', () => {
      const { w, P } = world();
      P.validUnits = ['day', 'week'];
      expect(proj(w, { newReviewInterval: { steps: 2, unit: 'weeks' }, reviewIntervalLabel: '2 weeks' }))
        .toEqual({ success: false, error: 'review interval: did not read back as written' });
    });
  });

  describe('completed occurrences of repeating items (#124)', () => {
    function repeating() {
      const ctx = world();
      ctx.T.repetitionRule = weekly();
      const done = ctx.T.markComplete();
      return { ...ctx, done };
    }

    it('refuses to edit a completed occurrence by default', () => {
      const { run, done } = repeating();
      const out = run({ id: done.id.primaryKey, newStatus: 'dropped' });
      expect(out.success).toBe(false);
      expect(out.error).toBe('This is a completed occurrence of a repeating item, not a duplicate. Mutating it can cascade through the live repeat chain. Query without includeCompleted to get the live occurrence, or pass allowPastOccurrence: true if you really mean this one.');
      expect(done.dropDate).toBeNull();
    });

    it('edits the live occurrence without complaint', () => {
      const { run, T } = repeating();
      expect(run({ newName: 'x' }).success).toBe(true);
      expect(T.name).toBe('x');
    });

    it('allowPastOccurrence opts in', () => {
      const { run, done } = repeating();
      expect(run({ id: done.id.primaryKey, allowPastOccurrence: true, newName: 'x' }).success).toBe(true);
      expect(done.name).toBe('x');
    });

    it('keys on repeating-plus-terminal-status, never on id shape', () => {
      const { w } = world();
      const live = w.project('Weekly review', null, 'bY_WHmMzWfC.116');
      live.repetitionRule = weekly();
      const out = runWriteScript('editItem.js', { itemType: 'project', id: 'bY_WHmMzWfC.116', allowPastOccurrence: false, newName: 'x' }, w.globals);
      expect(out.success).toBe(true);
    });

    it('lets a completed non-repeating item through untouched', () => {
      const { run, T } = world();
      T.markComplete();
      expect(run({ newName: 'x' }).success).toBe(true);
    });
  });

  it('lands every field in one call in the documented order', () => {
    const { run, w } = world();
    w.project('Marketing');
    const out = run({
      newName: 'n', newNote: 'o', newDueDate: null, newDeferDate: null, newPlannedDate: null, newFlagged: false, newEstimatedMinutes: 5,
      newRepeat: null, addTags: ['a'], removeTags: ['b'], newStatus: 'completed', newProjectName: 'Marketing', move: { position: 'end' },
    });
    expect(out.changedProperties).toBe(
      'name, note, due date, defer date, planned date, flagged, estimated minutes, repetition (cleared), tags (added), tags (removed), status (completed), project (moved to Marketing), position (end)'
    );
  });
});

// Type-only use so the import is not flagged unused when FakeTask is not referenced above.
export type _T = FakeTask;
