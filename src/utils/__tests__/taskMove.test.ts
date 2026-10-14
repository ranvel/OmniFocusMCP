import { describe, it, expect } from 'vitest';
import { standardWorld } from './omniJsFake.js';
import { loadHelpers } from './runWriteScript.js';
import type { TaskMoveSpec } from '../taskMove.js';

/**
 * Run `moveTask` from _writeHelpers.js against the OmniJS fake: tasks with
 * parent/children, projects whose top level is a root task, an inbox, and
 * moveTasks() with insertion locations. Pins what the helper DOES (where the
 * task lands, what it refuses), not how it's spelled.
 */
function build() {
  const ctx = standardWorld();
  const h = loadHelpers(ctx.w.globals);
  const Task = ctx.w.globals.Task as any;
  const run = (taskId: string, spec: TaskMoveSpec): string => h.moveTask(Task.byIdentifier(taskId), spec);
  const names = (c: any) => ctx.w.names(c);
  return { ...ctx, h, run, names, setTamper: (f: (t: any) => void) => { ctx.w.moveTamper = f; } };
}

describe('moveTask: nesting (#138)', () => {
  it('nests a task under a sibling, at the end by default', () => {
    const w = build();
    const label = w.run('C', { parentId: 'A' });
    expect(w.names(w.A)).toEqual(['A1', 'C']);
    expect(w.names(w.P1)).toEqual(['A', 'B', 'D']);
    expect(label).toBe('parent (moved under Task A)');
  });

  it('"" returns a nested task to its project top level', () => {
    const w = build();
    const label = w.run('A1', { parentId: '' });
    expect(w.A1.parent).toBe(w.P1.task);
    expect(w.names(w.P1)).toEqual(['A', 'B', 'C', 'D', 'A1']);
    expect(label).toBe('parent (project root)');
  });

  it('"" returns a subtask of an inbox task to the inbox', () => {
    const w = build();
    w.run('I2', { parentId: 'I1' });
    expect(w.names(w.I1)).toEqual(['I2']);
    const label = w.run('I2', { parentId: '' });
    expect(w.I2.parent).toBeNull();
    expect(w.names(null)).toEqual(['I1', 'I2']);
    expect(label).toBe('parent (inbox)');
  });

  it('follows a parent in another project', () => {
    const w = build();
    w.run('B', { parentId: 'X' });
    expect(w.B.parent).toBe(w.X);
    expect(w.B.containingProject!.name).toBe('Project Two');
    expect(w.names(w.P1)).toEqual(['A', 'C', 'D']);
  });

  it('follows a parent in the inbox', () => {
    const w = build();
    w.run('B', { parentId: 'I1' });
    expect(w.B.containingProject).toBeNull();
    expect(w.names(w.I1)).toEqual(['B']);
  });

  it('refuses the task itself as parent', () => {
    const w = build();
    expect(() => w.run('A', { parentId: 'A' })).toThrow(/under itself or one of its own subtasks/);
  });

  it('refuses a descendant as parent (cycle), leaving the tree untouched', () => {
    const w = build();
    expect(() => w.run('A', { parentId: 'A1' })).toThrow(/under itself or one of its own subtasks/);
    expect(w.names(w.P1)).toEqual(['A', 'B', 'C', 'D']);
    expect(w.names(w.A)).toEqual(['A1']);
  });

  it('refuses an unknown parent id', () => {
    const w = build();
    expect(() => w.run('A', { parentId: 'nope' })).toThrow(/parent task not found: nope/);
  });

  it('refuses a project id as parent, pointing at newProjectName', () => {
    const w = build();
    expect(() => w.run('A', { parentId: 'P2' })).toThrow(/use newProjectName/);
  });

  it('refuses to move a project', () => {
    const w = build();
    expect(() => w.run('P1', { position: 'beginning' })).toThrow(/projects cannot be nested/);
  });
});

describe('moveTask: position (#138)', () => {
  it.each([
    ['beginning', 'beginning', ['C', 'A', 'B', 'D']],
    ['end', 'end', ['A', 'B', 'D', 'C']],
    ['before A', { before: 'A' }, ['C', 'A', 'B', 'D']],
    ['after A', { after: 'A' }, ['A', 'C', 'B', 'D']],
    ['after D', { after: 'D' }, ['A', 'B', 'D', 'C']],
    ['before D', { before: 'D' }, ['A', 'B', 'C', 'D']],
  ] as const)('position %s without a parent reorders within the current container', (_l, position, order) => {
    const w = build();
    const label = w.run('C', { position: position as any });
    expect(w.names(w.P1)).toEqual(order);
    expect(w.C.parent).toBe(w.P1.task);
    expect(label).toBe('');
  });

  it('combines a new parent with a position', () => {
    const w = build();
    w.run('C', { parentId: 'A', position: 'beginning' });
    expect(w.names(w.A)).toEqual(['C', 'A1']);
    w.run('D', { parentId: 'A', position: { after: 'C' } });
    expect(w.names(w.A)).toEqual(['C', 'D', 'A1']);
    w.run('B', { parentId: 'A', position: { before: 'A1' } });
    expect(w.names(w.A)).toEqual(['C', 'D', 'B', 'A1']);
  });

  it('reorders at the inbox top level', () => {
    const w = build();
    w.run('I2', { position: 'beginning' });
    expect(w.names(null)).toEqual(['I2', 'I1']);
  });

  it('refuses a before/after task that does not share the target parent', () => {
    const w = build();
    // A1 lives under A, not at the project top level where C is.
    expect(() => w.run('C', { position: { after: 'A1' } })).toThrow(/not in the target container/);
    // With a new parent, the sibling must be under THAT parent.
    expect(() => w.run('C', { parentId: 'A', position: { before: 'B' } })).toThrow(/not in the target container/);
    expect(w.names(w.P1)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('refuses the task itself as its own anchor', () => {
    const w = build();
    expect(() => w.run('C', { position: { before: 'C' } })).toThrow(/cannot be placed before itself/);
  });

  it('refuses an unknown anchor id', () => {
    const w = build();
    expect(() => w.run('C', { position: { after: 'zzz' } })).toThrow(/after task not found: zzz/);
  });
});

describe('moveTask: read-back', () => {
  it('throws if the task lands under a different parent than asked', () => {
    const w = build();
    w.setTamper(t => { t.parent = w.P2.task; });
    expect(() => w.run('C', { parentId: 'A' })).toThrow(/did not land under the requested parent/);
  });

  it('throws if the task lands at a different position than asked', () => {
    const w = build();
    w.setTamper(t => {
      const k = w.P1.task.children;
      k.splice(k.indexOf(t), 1);
      k.push(t);
    });
    expect(() => w.run('C', { position: 'beginning' })).toThrow(/did not land at the requested position/);
  });
});

describe('moveLabel', () => {
  it('builds the changedProperties label from parent and position', () => {
    const { h } = build();
    expect(h.moveLabel({ parentId: 'A' }, 'parent (moved under Task A)')).toBe('parent (moved under Task A)');
    expect(h.moveLabel({ parentId: 'A', position: { after: 'B' } }, 'parent (moved under Task A)')).toBe('parent (moved under Task A), position (after B)');
    expect(h.moveLabel({ position: 'beginning' }, '')).toBe('position (beginning)');
    expect(h.moveLabel({ position: { before: 'Q' } }, '')).toBe('position (before Q)');
  });
});
