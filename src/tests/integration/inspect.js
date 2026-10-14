// Integration-test read-back: everything about one task or project, by id.
// Runs through the READ tunnel (executeOmniFocusScript) with the id as argv[0].
(() => {
  const id = argv[0];
  const p = Project.byIdentifier(id);
  const t = Task.byIdentifier(id);
  const x = p || t;
  if (!x) return JSON.stringify({ found: false });
  const r = x.repetitionRule;
  const task = p ? null : t;
  const parent = task ? task.parent : null;
  let siblings = [];
  if (parent) siblings = parent.children;
  else if (task && task.inInbox) for (let i = 0; i < inbox.length; i++) siblings.push(inbox[i]);
  const status = v => (v ? String(v).replace(/^\[object [\w.]+: (\w+)\]$/, '$1') : null);
  return JSON.stringify({
    found: true,
    name: x.name,
    note: x.note,
    due: formatDate(x.dueDate),
    defer: formatDate(x.deferDate),
    planned: task ? formatDate(task.plannedDate) : null,
    flagged: x.flagged,
    estimatedMinutes: x.estimatedMinutes,
    tags: x.tags.map(g => g.name),
    rule: r ? r.ruleString : null,
    anchor: r && r.anchorDateKey ? status(r.anchorDateKey) : null,
    schedule: r ? status(r.scheduleType) : null,
    catchUp: r ? r.catchUpAutomatically : null,
    taskStatus: task ? status(task.taskStatus) : null,
    completed: task ? task.completed : null,
    dropDate: task ? formatDate(task.dropDate) : null,
    parentId: parent ? parent.id.primaryKey : null,
    parentIsRoot: parent ? !!parent.project : null,
    siblingIds: siblings.map(s => s.id.primaryKey),
    inInbox: task ? task.inInbox : null,
    containingProject: task && task.containingProject ? task.containingProject.name : null,
    projectStatus: p ? status(p.status) : null,
    sequential: p ? p.sequential : null,
    reviewSteps: p ? p.reviewInterval.steps : null,
    reviewUnit: p ? p.reviewInterval.unit : null,
    lastReviewDate: p ? formatDate(p.lastReviewDate) : null,
    nextReviewDate: p ? formatDate(p.nextReviewDate) : null,
    folder: p && p.parentFolder ? p.parentFolder.name : null,
    occurrences: flattenedTasks
      .filter(o => o.id.primaryKey.indexOf(id + '.') === 0)
      .map(o => ({ id: o.id.primaryKey, status: status(o.taskStatus), completed: o.completed, dropDate: formatDate(o.dropDate) })),
  });
})()
