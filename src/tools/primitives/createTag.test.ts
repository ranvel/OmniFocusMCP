import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildWorld } from '../../utils/__tests__/omniJsFake.js';
import { runWriteScript } from '../../utils/__tests__/runWriteScript.js';

vi.mock('../../utils/scriptExecution.js', () => ({
  executeOmniFocusWrite: vi.fn(async () => ({ success: true, tagId: 'TAG1' })),
}));

import { executeOmniFocusWrite } from '../../utils/scriptExecution.js';
import { createTag } from './createTag.js';

const tunnel = vi.mocked(executeOmniFocusWrite);
const run = (params: unknown, w = buildWorld()) => ({ out: runWriteScript('createTag.js', params, w.globals), w });

beforeEach(() => {
  tunnel.mockClear();
  tunnel.mockResolvedValue({ success: true, tagId: 'TAG1' });
});

describe('createTag: what the primitive sends', () => {
  it('sends the name alone for a top-level tag', async () => {
    await createTag({ name: 'Errands' });
    expect(tunnel).toHaveBeenCalledWith('@createTag.js', { name: 'Errands' });
  });

  it('prefers parentTagID over parentTagName when both are given', async () => {
    await createTag({ name: 'X', parentTagID: 'id99', parentTagName: 'ByName' });
    expect(tunnel).toHaveBeenCalledWith('@createTag.js', { name: 'X', parentTagID: 'id99' });
  });

  it('sends parentTagName when there is no id', async () => {
    await createTag({ name: 'Groceries', parentTagName: 'Errands' });
    expect(tunnel).toHaveBeenCalledWith('@createTag.js', { name: 'Groceries', parentTagName: 'Errands' });
  });

  it('flattens newlines in names, as the AppleScript write did', async () => {
    await createTag({ name: 'Two\nlines', parentTagName: 'Pa\r\nrent' });
    expect(tunnel).toHaveBeenCalledWith('@createTag.js', { name: 'Two lines', parentTagName: 'Pa rent' });
  });

  it('returns success JSON shape with tagId and echoes the caller name', async () => {
    expect(await createTag({ name: 'T' })).toEqual({ success: true, tagId: 'TAG1', name: 'T' });
  });

  it('passes a script failure through without a name', async () => {
    tunnel.mockResolvedValue({ success: false, error: 'Parent tag not found: Nope' });
    expect(await createTag({ name: 'T', parentTagName: 'Nope' })).toEqual({
      success: false,
      error: 'Parent tag not found: Nope',
    });
  });

  it('never throws to the caller', async () => {
    tunnel.mockRejectedValue(new Error('osascript exploded'));
    expect(await createTag({ name: 'T' })).toEqual({ success: false, error: 'osascript exploded' });
  });
});

describe('createTag.js: what the script does', () => {
  it('creates a top-level tag', () => {
    const { out, w } = run({ name: 'Errands' });
    expect(out).toEqual({ success: true, tagId: w.tags[0].id.primaryKey });
    expect(w.tags.map(t => [t.name, t.parent])).toEqual([['Errands', null]]);
  });

  it('nests under a parent tag by name', () => {
    const w = buildWorld();
    const parent = w.tag('Errands');
    const { out } = run({ name: 'Groceries', parentTagName: 'Errands' }, w);
    expect(out.success).toBe(true);
    expect(w.tags[1].parent).toBe(parent);
    expect(parent.children.map(t => t.name)).toEqual(['Groceries']);
  });

  it('matches the parent name case-insensitively, as AppleScript did', () => {
    const w = buildWorld();
    const parent = w.tag('Errands');
    run({ name: 'Groceries', parentTagName: 'errands' }, w);
    expect(w.tags[1].parent).toBe(parent);
  });

  it('nests under a parent tag by id', () => {
    const w = buildWorld();
    const parent = w.tag('Errands', null, 'abc123');
    const { out } = run({ name: 'Groceries', parentTagID: 'abc123' }, w);
    expect(out.success).toBe(true);
    expect(w.tags[1].parent).toBe(parent);
  });

  it('reports a missing parent by the identifier the caller used', () => {
    expect(run({ name: 'G', parentTagName: 'Errands' }).out).toEqual({
      success: false,
      error: 'Parent tag not found: Errands',
    });
    expect(run({ name: 'G', parentTagID: 'abc123' }).out).toEqual({
      success: false,
      error: 'Parent tag not found: abc123',
    });
  });

  it('creates nothing when the parent is missing', () => {
    const { w } = run({ name: 'G', parentTagName: 'Errands' });
    expect(w.tags).toHaveLength(0);
  });

  it('keeps special characters in the tag name verbatim (#103)', () => {
    const name = 'My "Tag" \\ `with` ${all} the \'things\'';
    const { out, w } = run({ name });
    expect(out.success).toBe(true);
    expect(w.tags[0].name).toBe(name);
  });

  it('does not deduplicate: a second tag with the same name is created', () => {
    const w = buildWorld();
    w.tag('Errands');
    run({ name: 'Errands' }, w);
    expect(w.tags.map(t => t.name)).toEqual(['Errands', 'Errands']);
  });
});
