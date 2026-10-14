import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildWorld, RepetitionRule } from '../../utils/__tests__/omniJsFake.js';
import { runWriteScript } from '../../utils/__tests__/runWriteScript.js';

vi.mock('../../utils/scriptExecution.js', () => ({
  executeOmniFocusWrite: vi.fn(async () => ({ success: true, id: 'abc123', name: 'Old Task' })),
}));

import { executeOmniFocusWrite } from '../../utils/scriptExecution.js';
import { removeItem } from './removeItem.js';

const tunnel = vi.mocked(executeOmniFocusWrite);
const run = (params: unknown, w = buildWorld()) => ({ out: runWriteScript('removeItem.js', params, w.globals), w });
const weekly = () => new RepetitionRule('FREQ=WEEKLY', null, 'Regularly', 'DueDate', false);

beforeEach(() => {
  tunnel.mockClear();
  tunnel.mockResolvedValue({ success: true, id: 'abc123', name: 'Old Task' });
});

describe('removeItem: what the primitive sends', () => {
  it('generates task removal by name', async () => {
    await removeItem({ name: 'Old Task', itemType: 'task' });
    expect(tunnel).toHaveBeenCalledWith('@removeItem.js', { name: 'Old Task', itemType: 'task', allowPastOccurrence: false });
  });

  it('generates task removal by id', async () => {
    await removeItem({ id: 'abc123', itemType: 'task' });
    expect(tunnel).toHaveBeenCalledWith('@removeItem.js', { id: 'abc123', itemType: 'task', allowPastOccurrence: false });
  });

  it('generates project removal by name', async () => {
    await removeItem({ name: 'Old Project', itemType: 'project' });
    expect(tunnel).toHaveBeenCalledWith('@removeItem.js', { name: 'Old Project', itemType: 'project', allowPastOccurrence: false });
  });

  it('passes the past-occurrence opt-in through (#124)', async () => {
    await removeItem({ id: 'x.1', itemType: 'task', allowPastOccurrence: true });
    expect(tunnel.mock.calls[0][1]).toMatchObject({ allowPastOccurrence: true });
  });

  it('returns error when neither id nor name provided, without reaching OmniFocus', async () => {
    expect(await removeItem({ itemType: 'task' })).toEqual({ success: false, error: 'Either id or name must be provided' });
    expect(tunnel).not.toHaveBeenCalled();
  });

  it('returns the id and name the script reports', async () => {
    expect(await removeItem({ id: 'abc123', itemType: 'task' })).toEqual({ success: true, id: 'abc123', name: 'Old Task' });
  });

  it('passes a script failure through', async () => {
    tunnel.mockResolvedValue({ success: false, error: 'Item not found' });
    expect(await removeItem({ id: 'nope', itemType: 'task' })).toEqual({ success: false, error: 'Item not found' });
  });
});

describe('removeItem.js: what the script does', () => {
  it('deletes a task by id and reports its id and name', () => {
    const w = buildWorld();
    const P = w.project('Work');
    const t = w.task('Old Task', P, 'abc123');
    const { out } = run({ id: 'abc123', itemType: 'task', allowPastOccurrence: false }, w);
    expect(out).toEqual({ success: true, id: 'abc123', name: 'Old Task' });
    expect(w.tasks).not.toContain(t);
    expect(w.names(P)).toEqual([]);
  });

  it('deletes a task by name, matching case-insensitively', () => {
    const w = buildWorld();
    w.task('Old Task', null, 'T1');
    const { out } = run({ name: 'old task', itemType: 'task', allowPastOccurrence: false }, w);
    expect(out).toEqual({ success: true, id: 'T1', name: 'Old Task' });
    expect(w.inboxList).toHaveLength(0);
  });

  it('falls back to the name when the id does not resolve', () => {
    const w = buildWorld();
    w.task('Old Task', null, 'T1');
    const { out } = run({ id: 'stale', name: 'Old Task', itemType: 'task', allowPastOccurrence: false }, w);
    expect(out).toEqual({ success: true, id: 'T1', name: 'Old Task' });
  });

  it('deletes a project by name, with its tasks', () => {
    const w = buildWorld();
    const P = w.project('Old Project', null, 'P1');
    w.task('child', P);
    const { out } = run({ name: 'Old Project', itemType: 'project', allowPastOccurrence: false }, w);
    expect(out).toEqual({ success: true, id: 'P1', name: 'Old Project' });
    expect(w.projects).toHaveLength(0);
    expect(w.tasks).toHaveLength(0);
  });

  it('deletes a project by its id, which is also its root task id (#77)', () => {
    const w = buildWorld();
    w.project('Old Project', null, 'P1');
    const { out } = run({ id: 'P1', itemType: 'project', allowPastOccurrence: false }, w);
    expect(out).toEqual({ success: true, id: 'P1', name: 'Old Project' });
  });

  it('reports Item not found when nothing matches', () => {
    expect(run({ id: 'nope', name: 'nothing', itemType: 'task', allowPastOccurrence: false }).out).toEqual({
      success: false,
      error: 'Item not found',
    });
  });

  it('keeps a hostile name verbatim in the result (#103)', () => {
    const w = buildWorld();
    const name = 'retitle to "policy \\ infrastructure" engineer';
    w.task(name, null, 'T1');
    expect(run({ id: 'T1', itemType: 'task', allowPastOccurrence: false }, w).out).toEqual({ success: true, id: 'T1', name });
  });

  describe('completed occurrences of repeating items (#124)', () => {
    function repeating() {
      const w = buildWorld();
      const P = w.project('Work');
      const live = w.task('Daily', P, 'D');
      live.repetitionRule = weekly();
      const done = live.markComplete();
      return { w, live, done };
    }

    it('refuses to delete a completed occurrence by default', () => {
      const { w, done } = repeating();
      const { out } = run({ id: done.id.primaryKey, itemType: 'task', allowPastOccurrence: false }, w);
      expect(out.success).toBe(false);
      expect(out.error).toMatch(/completed occurrence of a repeating item/);
      expect(w.tasks).toContain(done);
    });

    it('deletes the live occurrence without complaint', () => {
      const { w, live } = repeating();
      expect(run({ id: 'D', itemType: 'task', allowPastOccurrence: false }, w).out.success).toBe(true);
      expect(w.tasks).not.toContain(live);
    });

    it('allowPastOccurrence opts into deleting the completed occurrence', () => {
      const { w, done } = repeating();
      expect(run({ id: done.id.primaryKey, itemType: 'task', allowPastOccurrence: true }, w).out.success).toBe(true);
      expect(w.tasks).not.toContain(done);
    });

    it('leaves a non-repeating completed task alone: it is not an occurrence', () => {
      const w = buildWorld();
      const t = w.task('Once', null, 'O');
      t.markComplete();
      expect(run({ id: 'O', itemType: 'task', allowPastOccurrence: false }, w).out.success).toBe(true);
    });
  });
});
