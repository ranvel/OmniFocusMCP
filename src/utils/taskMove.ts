/**
 * Nesting and ordering an existing task (issue #138).
 *
 * `newProjectName` can move a task between projects, but nothing could put an
 * existing task under a parent task (an action group) or place it among its
 * siblings. Re-creating the tasks under a new parent loses their ids, and with
 * them every `omnifocus:///task/<id>` link that points at them. The move goes
 * through Omni Automation's `moveTasks()` — see `moveTask` in
 * `src/utils/omnifocusScripts/_writeHelpers.js`, which edit_item calls.
 *
 * Semantics, each chosen deliberately:
 * - `parentId` names the new parent task. `""` means the top level of the
 *   task's containing project, or the inbox when it has no project.
 * - A parent in another project (or the inbox) takes the task with it: the
 *   task follows its parent.
 * - `position` without `parentId` reorders inside the task's current container.
 * - `before`/`after` must name a task that is (or will be) a sibling, i.e.
 *   shares the target parent. Anything else is an error rather than a silent
 *   move somewhere the caller didn't name.
 * - A parent that is the task itself or one of its descendants is a cycle and
 *   is refused with a clear message before OmniFocus is asked.
 * - A project id as parent is refused: `newProjectName` is the project move.
 *
 * The move is read back — parent and index — and anything that didn't land as
 * asked fails the edit.
 */

export type TaskPosition = 'beginning' | 'end' | { before: string } | { after: string };

export interface TaskMoveSpec {
  /** New parent task id; "" = project root (or inbox). Omitted = stay put. */
  parentId?: string;
  position?: TaskPosition;
}
