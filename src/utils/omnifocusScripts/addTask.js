// Create a task in the inbox, at a project's top level, or under a parent task.
// params: { name, note?, dueDate?, deferDate?, plannedDate?, flagged?, estimatedMinutes?,
//           tags?, projectId?, projectName?, parentTaskId?, parentTaskName?, repeat? }
//   ->  { success, taskId, placement: 'parent' | 'project' | 'inbox' }
runWrite(function (params) {
  // Target project: by id if given, else by name or folder path.
  var project = null;
  if (params.projectId) {
    project = resolveProjectByIdOrRootTaskId(params.projectId);
    if (!project) throw new Error('Project not found: id ' + params.projectId);
  } else if (params.projectName) {
    project = resolveProjectByPath(params.projectName);
    if (!project) throw new Error('Project not found: ' + params.projectName);
  }

  // Parent task: by id, then by name. A parent outside the target project is
  // ignored rather than pulling the task into another project.
  var parent = null;
  if (params.parentTaskId) {
    parent = Task.byIdentifier(params.parentTaskId);
    if (parent && project && parent.containingProject !== project) parent = null;
  }
  if (!parent && params.parentTaskName) {
    parent = project
      ? firstByName(project.flattenedTasks, params.parentTaskName)
      : firstByName(flattenedTasks, params.parentTaskName);
  }

  var task = parent
    ? new Task(params.name, parent.ending)
    : project
      ? new Task(params.name, project.ending)
      : new Task(params.name, inbox.ending);

  if (params.note) task.note = params.note;
  if (params.dueDate) task.dueDate = dateFromParts(params.dueDate);
  if (params.deferDate) task.deferDate = dateFromParts(params.deferDate);
  if (params.plannedDate) task.plannedDate = dateFromParts(params.plannedDate);
  if (params.flagged) task.flagged = true;
  if (params.estimatedMinutes) task.estimatedMinutes = params.estimatedMinutes;
  // After the dates, so a defaulted fixed anchor sees them (#116).
  if (params.repeat) applyRepetition(task, params.repeat);

  var placement = placementOf(task, parent, project);
  var taskId = task.id.primaryKey;
  if (params.tags && params.tags.length > 0) addTagsByName(task, params.tags);

  return { success: true, taskId: taskId, placement: placement };
})
