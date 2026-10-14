// Edit a task or project found by id (then name as a fallback).
// params: see EditItemScriptParams in src/tools/primitives/editItem.ts
//   ->  { success, id, name, changedProperties }
// Fields are applied in a fixed order and each appends its label to
// changedProperties; the labels are part of the tool's contract.
runWrite(function (params) {
  var itemType = params.itemType;
  var item = resolveTaskOrProject(itemType, params.id, params.name);
  if (!item) throw new Error('Item not found');
  // Captured before any edit: the result names the item the caller targeted.
  var itemName = item.name;
  var id = itemId(item, itemType);
  if (!params.allowPastOccurrence) assertLiveOccurrence(item, itemType);
  var changed = [];

  // Fields common to tasks and projects.
  if (params.newName !== undefined) { item.name = params.newName; changed.push('name'); }
  if (params.newNote !== undefined) { item.note = params.newNote; changed.push('note'); }
  if (params.newDueDate !== undefined) { item.dueDate = dateFromParts(params.newDueDate); changed.push('due date'); }
  if (params.newDeferDate !== undefined) { item.deferDate = dateFromParts(params.newDeferDate); changed.push('defer date'); }
  if (params.newPlannedDate !== undefined) { item.plannedDate = dateFromParts(params.newPlannedDate); changed.push('planned date'); }
  if (params.newFlagged !== undefined) { item.flagged = params.newFlagged; changed.push('flagged'); }
  if (params.newEstimatedMinutes !== undefined) { item.estimatedMinutes = params.newEstimatedMinutes; changed.push('estimated minutes'); }

  // Repetition (#116): null clears; a rule is written after the date edits
  // above, so a defaulted fixed anchor sees the dates as they now stand.
  if (params.newRepeat !== undefined) {
    if (params.newRepeat === null) {
      item.repetitionRule = null;
      changed.push('repetition (cleared)');
    } else {
      var anchor = applyRepetition(item, params.newRepeat);
      changed.push(repetitionLabel(params.newRepeat, anchor));
    }
  }

  // Tags apply to tasks and projects alike; replace wins over add/remove.
  if (params.replaceTags && params.replaceTags.length > 0) {
    item.clearTags();
    addTagsByName(item, params.replaceTags);
    changed.push('tags (replaced)');
  } else {
    if (params.addTags && params.addTags.length > 0) { addTagsByName(item, params.addTags); changed.push('tags (added)'); }
    if (params.removeTags && params.removeTags.length > 0) { removeTagsByName(item, params.removeTags); changed.push('tags (removed)'); }
  }

  if (itemType === 'task') {
    if (params.newStatus !== undefined) changed.push(setTaskStatus(item, params.newStatus));

    if (params.newProjectName !== undefined) {
      if (params.newProjectName === '' || params.newProjectName.toLowerCase() === 'inbox') {
        moveTasks([item], inbox.ending);
        changed.push('project (moved to inbox)');
      } else {
        var dest = resolveProjectByPath(params.newProjectName);
        if (!dest) throw new Error('Project not found: ' + params.newProjectName);
        moveTasks([item], dest.ending);
        changed.push('project (moved to ' + params.newProjectName + ')');
      }
    }

    // Nest / reorder (#138), after any project move, so a position alone
    // reorders within the project the task just landed in.
    if (params.move) changed.push(moveLabel(params.move, moveTask(item, params.move)));
  }

  if (itemType === 'project') {
    if (params.newSequential !== undefined) { item.sequential = params.newSequential; changed.push('sequential'); }
    if (params.newProjectStatus !== undefined) changed.push(setProjectStatus(item, params.newProjectStatus));

    // Review interval (#139) before markReviewed, so a combined call schedules
    // the next review from the new interval.
    if (params.newReviewInterval !== undefined) {
      applyReviewInterval(item, params.newReviewInterval);
      changed.push('review interval (every ' + params.reviewIntervalLabel + ')');
    }
    if (params.markReviewed === true) { markProjectReviewed(item); changed.push('marked reviewed'); }

    if (params.newFolderName !== undefined && params.newFolderName !== '') {
      var folder = resolveFolderByPath(params.newFolderName);
      if (!folder) throw new Error('Folder not found: ' + params.newFolderName);
      moveSections([item], folder.ending);
      changed.push('folder');
    }
  }

  return { success: true, id: id, name: itemName, changedProperties: changed.join(', ') };
})
