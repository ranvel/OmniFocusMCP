import { describe, it, expect } from 'vitest';
import { generateAppleScript as generateEditItemScript } from './editItem.js';
import { buildWorld } from '../../utils/__tests__/omniJsFake.js';
import { runWriteScript } from '../../utils/__tests__/runWriteScript.js';

/**
 * Issue #103: every write primitive returns a hand-built JSON payload from
 * AppleScript. A quote in a user-supplied name used to corrupt that payload —
 * the write succeeded, the result failed to parse, and the tool reported an
 * error (a duplicate-retry hazard). This suite pins the two defenses:
 *
 * 1. TS-known values are either dropped from the payload (the caller already
 *    has them) or double-escaped via escapeForJsonInAppleScript.
 * 2. Runtime-only values (current item name, AppleScript error text) route
 *    through the script's own `jsonEscape` handler.
 */

// A name built from the live repro: straight quotes (inch marks) are the ones
// that corrupt JSON; backslashes ride along to catch the escape-order bug.
const HOSTILE = 'retitle to "policy \\ infrastructure" engineer';

/**
 * Evaluate what a pure (splice-free) AppleScript string-literal line returns at
 * runtime, then JSON.parse it — the same pipeline the daemon runs.
 */
function parseReturnedJson(scriptLine: string): any {
  const literal = scriptLine.slice(scriptLine.indexOf('"') + 1, scriptLine.lastIndexOf('"'));
  return JSON.parse(literal.replace(/\\(.)/g, '$1'));
}

function lineContaining(script: string, marker: string): string {
  const line = script.split('\n').find(l => l.includes(marker));
  expect(line, `expected a line containing ${marker}`).toBeDefined();
  return line!;
}

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
    // Migrated to OmniJS: the payload is JSON.stringify'd inside OmniFocus, so
    // the hostile name is handled by construction. Pinned by running the script.
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
    it('routes runtime name and changed-properties text through jsonEscape', () => {
      const script = generateEditItemScript({ id: 'abc', itemType: 'task', newName: 'renamed' });
      expect(script).toContain('on jsonEscape(theText)');
      expect(script).toContain('my jsonEscape(itemName)');
      expect(script).toContain('my jsonEscape(changedPropsText)');
      expect(script).toContain('my jsonEscape(errorMessage)');
    });

    it('project-not-found error JSON survives a quoted destination', () => {
      const script = generateEditItemScript({
        id: 'abc',
        itemType: 'task',
        newProjectName: 'Say "when"',
      });
      const result = parseReturnedJson(lineContaining(script, 'Project not found'));
      expect(result.success).toBe(false);
      expect(result.error).toBe('Project not found: Say "when"');
    });

    it('folder-not-found error JSON survives a quoted destination', () => {
      const script = generateEditItemScript({
        id: 'abc',
        itemType: 'project',
        newFolderName: 'Say "when"',
      });
      const result = parseReturnedJson(lineContaining(script, 'Folder not found'));
      expect(result.success).toBe(false);
      expect(result.error).toBe('Folder not found: Say "when"');
    });
  });

  it('every write script defines the jsonEscape handler exactly once', () => {
    const scripts = [
      generateEditItemScript({ id: 'abc', itemType: 'task', newName: 'y' }),
    ];
    for (const script of scripts) {
      expect(script.match(/on jsonEscape\(theText\)/g)).toHaveLength(1);
    }
  });
});
