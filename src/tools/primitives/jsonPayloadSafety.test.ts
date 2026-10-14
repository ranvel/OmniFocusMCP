import { describe, it, expect } from 'vitest';
import { buildWorld } from '../../utils/__tests__/omniJsFake.js';
import { runWriteScript } from '../../utils/__tests__/runWriteScript.js';

/**
 * Issue #103: every write used to return a hand-built JSON payload from
 * AppleScript, and a quote in a user-supplied name corrupted it — the write
 * succeeded, the result failed to parse, and the tool reported an error (a
 * duplicate-retry hazard). The writes now run as OmniJS and build their
 * results with JSON.stringify, so the defense is structural. This suite runs
 * each script with the hostile name from the live repro and pins that the
 * result parses, carries the name verbatim where it should, and never echoes
 * it where it should not.
 */

// A name built from the live repro: straight quotes (inch marks) are the ones
// that corrupt JSON; backslashes ride along to catch the escape-order bug.
const HOSTILE = 'retitle to "policy \\ infrastructure" engineer';

describe('write-result JSON payload safety (#103)', () => {
  describe('add_omnifocus_task', () => {
    it('the success payload parses with a hostile task name and does not echo it', () => {
      const out = runWriteScript('addTask.js', { name: HOSTILE }, buildWorld().globals);
      expect(out.success).toBe(true);
      expect(out.placement).toBe('inbox');
      expect(JSON.stringify(out)).not.toContain('policy');
    });

    it('project-not-found error JSON survives a quoted project name', () => {
      const out = runWriteScript('addTask.js', { name: 'x', projectName: HOSTILE }, buildWorld().globals);
      expect(out).toEqual({ success: false, error: `Project not found: ${HOSTILE}` });
    });

    it('project-not-found-by-id error JSON survives a quoted id', () => {
      const out = runWriteScript('addTask.js', { name: 'x', projectId: 'id "with" quotes' }, buildWorld().globals);
      expect(out).toEqual({ success: false, error: 'Project not found: id id "with" quotes' });
    });
  });

  describe('add_project', () => {
    it('the success payload parses with a hostile project name and does not echo it', () => {
      const out = runWriteScript('addProject.js', { name: HOSTILE, sequential: false }, buildWorld().globals);
      expect(out.success).toBe(true);
      expect(JSON.stringify(out)).not.toContain('policy');
    });

    it('folder-not-found error JSON survives a quoted folder name', () => {
      const out = runWriteScript('addProject.js', { name: 'x', sequential: false, folderName: 'Q3 "Deep Work"' }, buildWorld().globals);
      expect(out).toEqual({ success: false, error: 'Folder not found: Q3 "Deep Work"' });
    });
  });

  describe('create_tag', () => {
    it('the success payload parses with a hostile tag name and does not echo it', () => {
      const out = runWriteScript('createTag.js', { name: HOSTILE }, buildWorld().globals);
      expect(out.success).toBe(true);
      expect(JSON.stringify(out)).not.toContain('policy');
    });

    it('parent-not-found error JSON survives a quoted parent name', () => {
      const out = runWriteScript('createTag.js', { name: 'x', parentTagName: 'the "urgent" bucket' }, buildWorld().globals);
      expect(out).toEqual({ success: false, error: 'Parent tag not found: the "urgent" bucket' });
    });
  });

  describe('remove_item', () => {
    it('the result parses and carries a hostile runtime item name verbatim', () => {
      const w = buildWorld();
      w.task(HOSTILE, null, 'abc');
      const out = runWriteScript('removeItem.js', { id: 'abc', itemType: 'task', allowPastOccurrence: false }, w.globals);
      expect(out).toEqual({ success: true, id: 'abc', name: HOSTILE });
    });
  });

  describe('edit_item', () => {
    it('the result carries the hostile runtime name and a hostile label verbatim', () => {
      const w = buildWorld();
      w.task(HOSTILE, null, 'abc');
      w.project('Say "when"');
      const out = runWriteScript('editItem.js', { id: 'abc', itemType: 'task', allowPastOccurrence: false, newName: 'renamed', newProjectName: 'Say "when"' }, w.globals);
      expect(out).toEqual({ success: true, id: 'abc', name: HOSTILE, changedProperties: 'name, project (moved to Say "when")' });
    });

    it('project-not-found error JSON survives a quoted destination', () => {
      const w = buildWorld();
      w.task('t', null, 'abc');
      const out = runWriteScript('editItem.js', { id: 'abc', itemType: 'task', allowPastOccurrence: false, newProjectName: 'Say "when"' }, w.globals);
      expect(out).toEqual({ success: false, error: 'Project not found: Say "when"' });
    });

    it('folder-not-found error JSON survives a quoted destination', () => {
      const w = buildWorld();
      w.project('p', null, 'abc');
      const out = runWriteScript('editItem.js', { id: 'abc', itemType: 'project', allowPastOccurrence: false, newFolderName: 'Say "when"' }, w.globals);
      expect(out).toEqual({ success: false, error: 'Folder not found: Say "when"' });
    });
  });
});
