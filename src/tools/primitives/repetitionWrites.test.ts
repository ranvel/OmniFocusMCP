import { describe, it, expect } from 'vitest';
import { buildAddTaskScriptParams } from './addOmniFocusTask.js';
import { buildAddProjectScriptParams } from './addProject.js';
import { buildEditItemScriptParams } from './editItem.js';
import { schema as addTaskSchema } from '../definitions/addOmniFocusTask.js';
import { schema as addProjectSchema } from '../definitions/addProject.js';
import { schema as editItemSchema } from '../definitions/editItem.js';
import { schema as batchSchema } from '../definitions/batchAddItems.js';
import { buildWorld, RepetitionRule } from '../../utils/__tests__/omniJsFake.js';
import { runWriteScript } from '../../utils/__tests__/runWriteScript.js';

/**
 * Repetition writes (#116). Rules are written through Omni Automation
 * (`repetitionRuleScript`), because the AppleScript record has no anchor field
 * and stored every fixed repeat as due-anchored. These tests pin that each write
 * site uses that path, on the right variable, AFTER its date writes.
 */
describe('repetition rule on create (#116)', () => {
  it('add_omnifocus_task writes through Omni Automation on the new task', () => {
    const params = buildAddTaskScriptParams({
      name: 'Weekly review',
      repeat: { method: 'start-after-completion', unit: 'week' },
    });
    expect(params.repeat).toEqual({
      method: 'start-after-completion', recurrence: 'FREQ=WEEKLY', schedule: 'FromCompletion', anchorKey: 'DeferDate', catchUp: false, isProject: false,
    });
    const w = buildWorld();
    expect(runWriteScript('addTask.js', params, w.globals).success).toBe(true);
    const rule = w.inboxList[0].repetitionRule!;
    expect(rule.ruleString).toBe('FREQ=WEEKLY');
    expect(String(rule.scheduleType)).toBe('FromCompletion');
  });

  it('add_project writes on the project (projects can repeat)', () => {
    const params = buildAddProjectScriptParams({
      name: 'Monthly close',
      repeat: { method: 'fixed', unit: 'month', steps: 3 },
    });
    expect(params.repeat).toMatchObject({ recurrence: 'FREQ=MONTHLY;INTERVAL=3', schedule: 'Regularly', isProject: true });
    const w = buildWorld();
    const out = runWriteScript('addProject.js', params, w.globals);
    expect(out.success).toBe(true);
    const rule = w.projects[0].repetitionRule!;
    expect(rule.ruleString).toBe('FREQ=MONTHLY;INTERVAL=3');
    // Projects have no planned date, so the default chain must not land on one.
    expect(String(rule.anchorDateKey)).toBe('DeferDate');
  });

  it('writes the rule after the dates, so a defaulted anchor sees them', () => {
    const params = buildAddTaskScriptParams({
      name: 'Fri review',
      deferDate: '2026-10-02',
      dueDate: '2026-10-09',
      repeat: { method: 'fixed', unit: 'week', weekdays: ['FR'] },
    });
    const w = buildWorld();
    runWriteScript('addTask.js', params, w.globals);
    // Only a rule written after the due date lands can default to it.
    expect(String(w.inboxList[0].repetitionRule!.anchorDateKey)).toBe('DueDate');
  });

  it('emits no repetition statement when no repeat is requested', () => {
    expect(buildAddTaskScriptParams({ name: 'One-shot' })).not.toHaveProperty('repeat');
    expect(buildAddProjectScriptParams({ name: 'One-shot' })).not.toHaveProperty('repeat');
  });

  it('compiles weekday sets through', () => {
    const params = buildAddTaskScriptParams({
      name: 'Strength',
      repeat: { method: 'fixed', unit: 'week', weekdays: ['TU', 'TH'] },
    });
    expect(params.repeat!.recurrence).toBe('FREQ=WEEKLY;BYDAY=TU,TH');
  });

  it('throws rather than creating a task with a silently-dropped repeat', () => {
    // The whole point of the feature is that repeats stop arriving inert; an
    // invalid spec must not degrade into "created, reported success, no repeat".
    expect(() =>
      buildAddTaskScriptParams({ name: 'Bad', repeat: { method: 'fixed', unit: 'week', steps: 0 } as any })
    ).toThrow();
  });
});

describe('repetition rule on edit (#116)', () => {
  function editWorld() {
    const w = buildWorld();
    const t = w.task('Task', null, 'abc');
    const p = w.project('Proj', null, 'p1');
    const run = (fields: Record<string, unknown>) => runWriteScript('editItem.js', { itemType: 'task', id: 'abc', allowPastOccurrence: false, ...fields }, w.globals);
    return { w, t, p, run };
  }

  it('sets a new rule through Omni Automation and labels what was stored', () => {
    const { t, run } = editWorld();
    const params = buildEditItemScriptParams({
      id: 'abc',
      itemType: 'task',
      newRepeat: { method: 'due-after-completion', unit: 'day', steps: 5 },
    });
    expect(params.newRepeat).toMatchObject({ recurrence: 'FREQ=DAILY;INTERVAL=5', schedule: 'FromCompletion' });
    expect(run(params).changedProperties).toBe('repetition (due after completion)');
    expect(t.repetitionRule!.ruleString).toBe('FREQ=DAILY;INTERVAL=5');
  });

  it('reports a fixed rule with the anchor actually stored', () => {
    const { run } = editWorld();
    const params = buildEditItemScriptParams({
      id: 'abc',
      itemType: 'task',
      newRepeat: { method: 'fixed', unit: 'week', weekdays: ['FR'], anchor: 'defer' },
    });
    expect(run(params).changedProperties).toBe('repetition (fixed, from defer date)');
  });

  it('writes the rule after any date edits in the same call', () => {
    const { t, run } = editWorld();
    t.dueDate = new Date('2026-10-09T00:00:00');
    const params = buildEditItemScriptParams({
      id: 'abc',
      itemType: 'task',
      newDeferDate: '2026-10-02',
      newDueDate: '',
      newRepeat: { method: 'fixed', unit: 'week' },
    });
    // The due date is cleared in this same call; only a rule written after
    // that can default to the defer date.
    expect(run(params).changedProperties).toBe('due date, defer date, repetition (fixed, from defer date)');
  });

  it('clears the rule when newRepeat is null', () => {
    const { t, run } = editWorld();
    t.repetitionRule = new RepetitionRule('FREQ=DAILY', null, 'Regularly', 'DueDate', false);
    expect(run(buildEditItemScriptParams({ id: 'abc', itemType: 'task', newRepeat: null })).changedProperties).toBe('repetition (cleared)');
    expect(t.repetitionRule).toBeNull();
  });

  it('distinguishes clearing from not-specified', () => {
    // `undefined` must be a no-op — otherwise every unrelated edit would wipe
    // the item's repeat.
    const { t, run } = editWorld();
    t.repetitionRule = new RepetitionRule('FREQ=DAILY', null, 'Regularly', 'DueDate', false);
    const params = buildEditItemScriptParams({ id: 'abc', itemType: 'task', newName: 'Renamed' });
    expect(params).not.toHaveProperty('newRepeat');
    run(params);
    expect(t.repetitionRule).not.toBeNull();
  });

  it('works on projects as well as tasks', () => {
    const { p, run } = editWorld();
    const params = buildEditItemScriptParams({
      id: 'p1',
      itemType: 'project',
      newRepeat: { method: 'fixed', unit: 'year' },
    });
    expect(params.newRepeat).toMatchObject({ recurrence: 'FREQ=YEARLY', isProject: true });
    expect(run({ ...params, itemType: 'project', id: 'p1' }).success).toBe(true);
    // Projects have no planned date, so the default chain must not land on one.
    expect(String(p.repetitionRule!.anchorDateKey)).toBe('DeferDate');
  });
});

/**
 * Schema parity. #97 shipped because add_omnifocus_task accepted `projectId`
 * while batch_add_items did not, so Zod stripped it and every batched task
 * landed in the inbox reporting success. A write field missing from one schema
 * is not a smaller bug than a broken one.
 */
describe('repeat is accepted by every write schema (#116)', () => {
  const repeat = { method: 'start-after-completion' as const, unit: 'week' as const, steps: 2 };

  it('add_omnifocus_task keeps repeat through validation', () => {
    const parsed = addTaskSchema.parse({ name: 'x', repeat });
    expect(parsed.repeat).toEqual(repeat);
  });

  it('add_project keeps repeat through validation', () => {
    expect(addProjectSchema.parse({ name: 'x', repeat }).repeat).toEqual(repeat);
  });

  it('batch_add_items keeps repeat on each item', () => {
    const parsed = batchSchema.parse({ items: [{ type: 'task', name: 'x', repeat }] });
    expect(parsed.items[0].repeat).toEqual(repeat);
  });

  it('edit_item keeps newRepeat, including an explicit null', () => {
    expect(editItemSchema.parse({ id: 'a', itemType: 'task', newRepeat: repeat }).newRepeat).toEqual(repeat);
    expect(editItemSchema.parse({ id: 'a', itemType: 'task', newRepeat: null }).newRepeat).toBeNull();
  });

  it('rejects an invalid method at the schema boundary', () => {
    expect(() => addTaskSchema.parse({ name: 'x', repeat: { method: 'whenever', unit: 'week' } })).toThrow();
  });

  it('rejects an invalid weekday code at the schema boundary', () => {
    expect(() =>
      addTaskSchema.parse({ name: 'x', repeat: { method: 'fixed', unit: 'week', weekdays: ['MON'] } })
    ).toThrow();
  });
});

/**
 * Occurrence safety (#124). OmniFocus 4 keeps completed occurrences of a
 * repeating item as separate rows carrying the same name AND rule as the live
 * one, so they read as duplicates. Mutating one cascades through the live chain.
 */
describe('past-occurrence guard (#124)', () => {
  function occurrence() {
    const w = buildWorld();
    const live = w.task('Daily', null, 'abc');
    live.repetitionRule = new RepetitionRule('FREQ=DAILY', null, 'Regularly', 'DueDate', false);
    const done = live.markComplete();
    const edit = (fields: Record<string, unknown>) => runWriteScript('editItem.js', { itemType: 'task', allowPastOccurrence: false, ...fields }, w.globals);
    return { w, live, done, edit };
  }

  it('guards edit_item by default', () => {
    const { done, edit } = occurrence();
    const out = edit({ id: done.id.primaryKey, newStatus: 'dropped' });
    expect(out.success).toBe(false);
    expect(out.error).toContain('completed occurrence of a repeating item');
    expect(done.dropDate).toBeNull();
  });

  it('guards remove_item by default', () => {
    const w = buildWorld();
    const live = w.task('Daily', null, 'abc');
    live.repetitionRule = new RepetitionRule('FREQ=DAILY', null, 'Regularly', 'DueDate', false);
    const done = live.markComplete();
    const out = runWriteScript('removeItem.js', { id: done.id.primaryKey, itemType: 'task', allowPastOccurrence: false }, w.globals);
    expect(out.success).toBe(false);
    expect(out.error).toContain('completed occurrence of a repeating item');
    expect(w.tasks).toContain(done);
  });

  it('is opt-out-able for the rare deliberate case', () => {
    const { done, edit } = occurrence();
    const out = edit({ id: done.id.primaryKey, newName: 'Daily (archived)', allowPastOccurrence: true });
    expect(out.success).toBe(true);
    expect(done.name).toBe('Daily (archived)');
  });

  it('keys on repeating-plus-terminal-status, never on id shape', () => {
    // A repeating PROJECT's live id is itself dotted (bY_WHmMzWfC.116 is Active),
    // so refusing dotted ids would make repeating projects uneditable.
    const w = buildWorld();
    const live = w.project('Weekly', null, 'bY_WHmMzWfC.116');
    live.repetitionRule = new RepetitionRule('FREQ=WEEKLY', null, 'Regularly', 'DueDate', false);
    const out = runWriteScript('editItem.js', { itemType: 'project', id: 'bY_WHmMzWfC.116', allowPastOccurrence: false, newName: 'x' }, w.globals);
    expect(out.success).toBe(true);
    expect(live.name).toBe('x');
  });

  it('lets a non-repeating item through untouched', () => {
    // The guard only trips when BOTH conditions hold; it must not add a status
    // check that blocks ordinary completed one-shots.
    const w = buildWorld();
    const t = w.task('Once', null, 'plain');
    t.markComplete();
    const out = runWriteScript('editItem.js', { itemType: 'task', id: 'plain', allowPastOccurrence: false, newName: 'x' }, w.globals);
    expect(out.success).toBe(true);
  });
});
