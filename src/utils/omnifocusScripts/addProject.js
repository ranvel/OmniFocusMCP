// Create a project, at the root or in a folder named by path.
// params: { name, note?, dueDate?, deferDate?, flagged?, estimatedMinutes?, tags?,
//           folderName?, sequential, repeat? }  ->  { success, projectId }
runWrite(function (params) {
  var folder = null;
  if (params.folderName) {
    folder = resolveFolderByPath(params.folderName);
    if (!folder) throw new Error('Folder not found: ' + params.folderName);
  }
  var project = folder ? new Project(params.name, folder.ending) : new Project(params.name);

  if (params.note) project.note = params.note;
  if (params.dueDate) project.dueDate = dateFromParts(params.dueDate);
  if (params.deferDate) project.deferDate = dateFromParts(params.deferDate);
  if (params.flagged) project.flagged = true;
  if (params.estimatedMinutes) project.estimatedMinutes = params.estimatedMinutes;
  project.sequential = params.sequential === true;
  // After the dates, so a defaulted fixed anchor sees them.
  if (params.repeat) applyRepetition(project, params.repeat);

  var projectId = project.task.id.primaryKey;
  if (params.tags && params.tags.length > 0) addTagsByName(project, params.tags);

  return { success: true, projectId: projectId };
})
