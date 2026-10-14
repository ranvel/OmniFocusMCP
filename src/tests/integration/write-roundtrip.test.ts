import { describe, it, expect } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  setupIntegration,
  registry,
  createTrackedTask,
  createTrackedProject,
  editItem,
} from './setup.js';
import { resolveItemName, createFolder } from './helpers.js';
import { createTag } from '../../tools/primitives/createTag.js';
import { executeOmniFocusScript } from '../../utils/scriptExecution.js';

/**
 * The OmniJS writes, read back from the live database. The lifecycle suites
 * check that calls succeed; this one checks that what landed is what was
 * asked for — the cases the AppleScript path got wrong or could not express.
 */

const INSPECT = join(dirname(fileURLToPath(import.meta.url)), 'inspect.js');
const inspect = (id: string) => executeOmniFocusScript(INSPECT, [id]);
const HOSTILE = 'TEST:He said "hi" \\ `tick` ${not} \'single\' — 27" 😀';
const HOSTILE_NOTE = 'Line 1 with "quotes"\nLine 2 with \\ backslash and `ticks`\n\t${tab}';

describe('Write round trips (integration)', () => {
  setupIntegration();

  let hostileId: string;

  it('keeps quotes, backslashes, backticks and ${} in a name and note (#103)', async () => {
    const result = await createTrackedTask({ name: HOSTILE, note: HOSTILE_NOTE, projectName: registry.testProject });
    expect(result.success).toBe(true);
    hostileId = result.taskId!;
    const seen = await inspect(hostileId);
    expect(seen.name).toBe(HOSTILE);
    expect(seen.note).toBe(HOSTILE_NOTE);
    expect(seen.containingProject).toBe(registry.testProject);
  });

  it('edits them again and reports the pre-edit name', async () => {
    const result = await editItem({ itemType: 'task', id: hostileId, newName: HOSTILE + ' v2', newNote: HOSTILE_NOTE + '\nv2' });
    expect(result.success).toBe(true);
    expect(result.name).toBe(HOSTILE);
    expect(result.changedProperties).toBe('name, note');
    const seen = await inspect(hostileId);
    expect(seen.name).toBe(HOSTILE + ' v2');
    expect(seen.note).toBe(HOSTILE_NOTE + '\nv2');
  });

  it('writes dates as the local calendar day asked for, whatever today is (#91)', async () => {
    const result = await createTrackedTask({
      name: 'TEST:Dates',
      projectName: registry.testProject,
      dueDate: '2026-11-01T17:00:00',
      deferDate: '2026-02-28',
      plannedDate: '2026-04-30',
    });
    expect(result.success).toBe(true);
    const seen = await inspect(result.taskId!);
    expect(seen.due).toMatch(/^2026-11-01T17:00:00/);
    expect(seen.defer).toMatch(/^2026-02-28T00:00:00/);
    expect(seen.planned).toMatch(/^2026-04-30T00:00:00/);

    const cleared = await editItem({ itemType: 'task', id: result.taskId!, newDueDate: '', newDeferDate: '2026-12-31' });
    expect(cleared.changedProperties).toBe('due date, defer date');
    const again = await inspect(result.taskId!);
    expect(again.due).toBeNull();
    expect(again.defer).toMatch(/^2026-12-31T00:00:00/);
  });

  it.each([
    ['due', { dueDate: '2026-10-20' }, 'DueDate'],
    ['defer', { deferDate: '2026-10-20' }, 'DeferDate'],
    ['planned', { plannedDate: '2026-10-20' }, 'PlannedDate'],
  ] as const)('repeats on a fixed schedule from the %s date (#116)', async (anchor, dates, key) => {
    const created = await createTrackedTask({ name: `TEST:Repeat ${anchor}`, projectName: registry.testProject, ...dates });
    expect(created.success).toBe(true);
    const edited = await editItem({
      itemType: 'task', id: created.taskId!,
      newRepeat: { method: 'fixed', unit: 'week', weekdays: ['TU', 'TH'], anchor, catchUp: anchor === 'due' },
    });
    expect(edited.success).toBe(true);
    expect(edited.changedProperties).toBe(`repetition (fixed, from ${anchor} date${anchor === 'due' ? ', catch up' : ''})`);
    const seen = await inspect(created.taskId!);
    expect(seen.rule).toBe('FREQ=WEEKLY;BYDAY=TU,TH');
    expect(seen.anchor).toBe(key);
    expect(seen.schedule).toBe('Regularly');
    expect(seen.catchUp).toBe(anchor === 'due');
  });

  it('defaults the anchor from the dates written in the same call, then clears', async () => {
    const created = await createTrackedTask({
      name: 'TEST:Repeat default', projectName: registry.testProject, deferDate: '2026-10-20',
      repeat: { method: 'start-after-completion', unit: 'month', steps: 2 },
    });
    expect(created.success).toBe(true);
    let seen = await inspect(created.taskId!);
    expect(seen.rule).toBe('FREQ=MONTHLY;INTERVAL=2');
    expect(seen.schedule).toBe('FromCompletion');
    expect(seen.anchor).toBe('DeferDate');

    const cleared = await editItem({ itemType: 'task', id: created.taskId!, newRepeat: null });
    expect(cleared.changedProperties).toBe('repetition (cleared)');
    seen = await inspect(created.taskId!);
    expect(seen.rule).toBeNull();
  });

  it('nests and orders tasks among their siblings (#138)', async () => {
    const parent = await createTrackedProject({ name: 'TEST:Ordering', folderName: registry.runFolder });
    expect(parent.success).toBe(true);
    const ids: string[] = [];
    for (const n of ['A', 'B', 'C']) {
      const r = await createTrackedTask({ name: `TEST:Order ${n}`, projectId: parent.projectId });
      expect(r.success).toBe(true);
      expect(r.placement).toBe('project');
      ids.push(r.taskId!);
    }
    const [A, B, C] = ids;

    let r = await editItem({ itemType: 'task', id: C, position: { before: A } });
    expect(r.changedProperties).toBe(`position (before ${A})`);
    expect((await inspect(C)).siblingIds).toEqual([C, A, B]);

    r = await editItem({ itemType: 'task', id: C, position: { after: A } });
    expect(r.changedProperties).toBe(`position (after ${A})`);
    expect((await inspect(C)).siblingIds).toEqual([A, C, B]);

    r = await editItem({ itemType: 'task', id: B, newParentTaskId: A, position: 'beginning' });
    expect(r.changedProperties).toBe('parent (moved under TEST:Order A), position (beginning)');
    const nested = await inspect(B);
    expect(nested.parentId).toBe(A);
    expect(nested.siblingIds).toEqual([B]);

    r = await editItem({ itemType: 'task', id: B, newParentTaskId: '' });
    expect(r.changedProperties).toBe('parent (project root)');
    expect((await inspect(B)).parentIsRoot).toBe(true);

    r = await editItem({ itemType: 'task', id: B, position: { after: 'nope' } });
    expect(r.success).toBe(false);
    expect(r.error).toBe('move: after task not found: nope');

    const child = await createTrackedTask({ name: 'TEST:Order child', parentTaskId: A });
    expect(child.placement).toBe('parent');
    expect((await inspect(child.taskId!)).parentId).toBe(A);
  });

  it('returns a project id that AppleScript and both OmniJS lookups resolve (#77)', async () => {
    const created = await createTrackedProject({ name: 'TEST:Id contract', folderName: registry.runFolder, sequential: true });
    expect(created.success).toBe(true);
    expect(await resolveItemName(created.projectId!, 'project')).toBe('TEST:Id contract');
    const byId = await editItem({ itemType: 'project', id: created.projectId!, newSequential: false });
    expect(byId.success).toBe(true);
    const seen = await inspect(created.projectId!);
    expect(seen.sequential).toBe(false);
    expect(seen.folder).toBe(registry.runFolder);
    const task = await createTrackedTask({ name: 'TEST:By project id', projectId: created.projectId });
    expect(task.placement).toBe('project');
    expect((await inspect(task.taskId!)).containingProject).toBe('TEST:Id contract');
  });

  it('skips an occurrence of a repeating task: dropped, and the next one scheduled', async () => {
    const created = await createTrackedTask({
      name: 'TEST:Skip me', projectName: registry.testProject, dueDate: '2026-10-14T09:00:00',
      repeat: { method: 'fixed', unit: 'day' },
    });
    expect(created.success).toBe(true);
    const id = created.taskId!;

    const refused = await editItem({ itemType: 'task', id, newStatus: 'skipped', newName: 'TEST:Skip me' });
    expect(refused.success).toBe(true); // repeating, so allowed

    const seen = await inspect(id);
    // The live occurrence keeps the id and has advanced a day.
    expect(seen.completed).toBe(false);
    expect(seen.dropDate).toBeNull();
    expect(seen.due).toMatch(/^2026-10-15T09:00:00/);
    // The skipped occurrence is a dropped clone, not a completed one.
    expect(seen.occurrences).toHaveLength(1);
    expect(seen.occurrences[0].status).toBe('Dropped');
    expect(seen.occurrences[0].completed).toBe(false);
    registry.track(seen.occurrences[0].id, 'TEST:Skip me', 'task');

    const plain = await createTrackedTask({ name: 'TEST:No repeat', projectName: registry.testProject });
    const nope = await editItem({ itemType: 'task', id: plain.taskId!, newStatus: 'skipped' });
    expect(nope).toEqual({ success: false, error: 'Cannot skip a non-repeating task. The task must have a repetition rule.' });
  });

  it('refuses to touch a completed occurrence unless asked (#124)', async () => {
    const created = await createTrackedTask({
      name: 'TEST:Complete me', projectName: registry.testProject, dueDate: '2026-10-14',
      repeat: { method: 'fixed', unit: 'week' },
    });
    const done = await editItem({ itemType: 'task', id: created.taskId!, newStatus: 'completed' });
    expect(done.changedProperties).toBe('status (completed)');
    const seen = await inspect(created.taskId!);
    expect(seen.occurrences).toHaveLength(1);
    const pastId = seen.occurrences[0].id;
    registry.track(pastId, 'TEST:Complete me', 'task');

    const refused = await editItem({ itemType: 'task', id: pastId, newFlagged: true });
    expect(refused.success).toBe(false);
    expect(refused.error).toMatch(/completed occurrence of a repeating item/);
    const allowed = await editItem({ itemType: 'task', id: pastId, newFlagged: true, allowPastOccurrence: true });
    expect(allowed.changedProperties).toBe('flagged');
  });

  it('tags projects and tasks, creating missing tags, and nests a created tag', async () => {
    const tag = await createTag({ name: 'TEST:Tag parent' });
    expect(tag.success).toBe(true);
    registry.track(tag.tagId!, 'TEST:Tag parent', 'tag');
    const child = await createTag({ name: 'TEST:Tag child', parentTagID: tag.tagId });
    expect(child.success).toBe(true);
    registry.track(child.tagId!, 'TEST:Tag child', 'tag');

    const r = await editItem({ itemType: 'project', id: registry.testProjectId, addTags: ['TEST:Tag child', 'TEST:Tag new'] });
    expect(r.changedProperties).toBe('tags (added)');
    let seen = await inspect(registry.testProjectId);
    expect(seen.tags).toEqual(['TEST:Tag child', 'TEST:Tag new']);
    const created = (await import('./helpers.js')).findItemsByPrefix('TEST:Tag new', 'tag');
    for (const t of await created) registry.track(t.id, t.name, 'tag');

    const r2 = await editItem({ itemType: 'project', id: registry.testProjectId, replaceTags: ['TEST:Tag parent'] });
    expect(r2.changedProperties).toBe('tags (replaced)');
    seen = await inspect(registry.testProjectId);
    expect(seen.tags).toEqual(['TEST:Tag parent']);

    const r3 = await editItem({ itemType: 'project', id: registry.testProjectId, removeTags: ['TEST:Tag parent', 'TEST:not a tag'] });
    expect(r3.changedProperties).toBe('tags (removed)');
    expect((await inspect(registry.testProjectId)).tags).toEqual([]);
  });

  it('sets a review interval, marks reviewed, and moves a project between folders (#139)', async () => {
    const other = await createFolder(`${registry.runFolder}/sub`.replace('/', ' '));
    registry.track(other, `${registry.runFolder} sub`, 'folder');
    const r = await editItem({
      itemType: 'project', id: registry.testProjectId,
      newReviewInterval: { steps: 3, unit: 'week' }, markReviewed: true, newProjectStatus: 'onHold',
    });
    expect(r.changedProperties).toBe('status (onHold), review interval (every 3 weeks), marked reviewed');
    let seen = await inspect(registry.testProjectId);
    expect(seen.reviewSteps).toBe(3);
    expect(seen.reviewUnit).toBe('weeks');
    expect(seen.projectStatus).toBe('OnHold');
    expect(seen.lastReviewDate).toMatch(/^2026-/);
    expect(seen.nextReviewDate).not.toBeNull();

    const moved = await editItem({ itemType: 'project', id: registry.testProjectId, newProjectStatus: 'active', newFolderName: `${registry.runFolder} sub` });
    expect(moved.changedProperties).toBe('status (active), folder');
    seen = await inspect(registry.testProjectId);
    expect(seen.folder).toBe(`${registry.runFolder} sub`);
    expect(seen.projectStatus).toBe('Active');

    const back = await editItem({ itemType: 'project', id: registry.testProjectId, newFolderName: registry.runFolder });
    expect(back.changedProperties).toBe('folder');
  });
});
