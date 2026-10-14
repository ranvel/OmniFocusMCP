// Shared helpers for the OmniJS write payloads. The write tunnel
// (executeOmniFocusWrite) prepends this file to every write script, after the
// formatDate prelude, so these are plain function declarations over the OmniJS
// globals: no imports, no top-level return, nothing executed at load. Written
// so the same text can be loaded under Node with fakes of those globals in
// scope (see src/utils/__tests__/runWriteScript.ts).

/**
 * Run a write body with the decoded parameters and return its result as the
 * JSON string the tunnel expects. Anything thrown becomes
 * `{ success: false, error }`, so a payload never leaks an exception to the
 * JXA shim (whose catch would wrap it in "Error: ... undefined:1:N").
 */
function runWrite(body) {
  try {
    return JSON.stringify(body(JSON.parse(argv[0])));
  } catch (e) {
    return JSON.stringify({ success: false, error: String((e && e.message) || e) });
  }
}

/** Case-insensitive equality, the way AppleScript's `whose name is` compares. */
function namesEqual(a, b) {
  return a === b || String(a).toLowerCase() === String(b).toLowerCase();
}

/**
 * First element of an OmniJS array whose name matches: an exact match wins,
 * otherwise the first case-insensitive one. `byName` alone is case-sensitive,
 * and the AppleScript lookups this replaces were not.
 */
function firstByName(list, name) {
  var fallback = null;
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    if (item.name === name) return item;
    if (fallback === null && namesEqual(item.name, name)) fallback = item;
  }
  return fallback;
}

/** "Work/Engineering" -> ["Work", "Engineering"]; empty components dropped. */
function splitPath(raw) {
  return String(raw).split('/').filter(function (c) { return c.length > 0; });
}

/**
 * A local wall-clock Date from the parts the TypeScript side computed, or null
 * to clear. Never parse an ISO string here: `new Date("2026-04-10")` is UTC
 * midnight, the previous evening anywhere behind UTC (#91).
 */
function dateFromParts(p) {
  if (p === null || p === undefined) return null;
  return new Date(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
}

/** The tag with this name, created at the top level if there is none. */
function ensureTag(name) {
  return firstByName(flattenedTags, name) || new Tag(name);
}

/**
 * The project for an id in either namespace: a project id, or the id of the
 * project's root task (what AppleScript called the project's id, #77). In
 * current OmniFocus the two are the same string; accepting both keeps every
 * id a query ever handed out working.
 */
function resolveProjectByIdOrRootTaskId(id) {
  var project = Project.byIdentifier(id);
  if (project) return project;
  var task = Task.byIdentifier(id);
  return task && task.project ? task.project : null;
}

/**
 * The item edit_item / remove_item operate on: by id first, then by name as a
 * fallback (AppleScript's `whose name is`, so case-insensitive). Null if
 * neither finds anything.
 */
function resolveTaskOrProject(itemType, id, name) {
  var item = null;
  if (id) {
    item = itemType === 'project' ? resolveProjectByIdOrRootTaskId(id) : Task.byIdentifier(id);
  }
  if (!item && name) {
    item = firstByName(itemType === 'project' ? flattenedProjects : flattenedTasks, name);
  }
  return item;
}

/** The id a result reports: a project's is its root task's id (#77). */
function itemId(item, itemType) {
  return itemType === 'project' ? item.task.id.primaryKey : item.id.primaryKey;
}

var OCCURRENCE_GUARD_ERROR =
  'This is a completed occurrence of a repeating item, not a duplicate. Mutating it can cascade ' +
  'through the live repeat chain. Query without includeCompleted to get the live occurrence, or ' +
  'pass allowPastOccurrence: true if you really mean this one.';

/**
 * True for a completed or dropped occurrence of a repeating item (#124).
 *
 * OmniFocus keeps each resolved occurrence as its own row with the same name
 * and rule as the live one; mutating such a row cascades through the chain.
 * Deliberately not an id-shape check: a repeating project's live id is itself
 * dotted. What separates history from the live item is a repetition rule plus
 * a terminal status of its own (not inherited from a container).
 */
function isPastOccurrence(item, itemType) {
  if (!item.repetitionRule) return false;
  if (itemType === 'project') {
    return item.status === Project.Status.Done || item.status === Project.Status.Dropped;
  }
  return item.completed === true || (item.dropDate !== null && item.dropDate !== undefined);
}

/** Throw the #124 refusal unless the item is the live occurrence. */
function assertLiveOccurrence(item, itemType) {
  if (isPastOccurrence(item, itemType)) throw new Error(OCCURRENCE_GUARD_ERROR);
}

/**
 * A folder by name ("Work") or by path ("Work/Engineering"): the leaf is
 * matched by name and every ancestor named in the path must match walking up
 * `.parent`. A component-less path ("", "/") names nothing and returns null,
 * so the caller fails loudly instead of falling through to a default.
 */
function resolveFolderByPath(raw) {
  var parts = splitPath(raw);
  if (parts.length === 0) return null;
  var leaf = parts[parts.length - 1];
  if (parts.length === 1) return firstByName(flattenedFolders, leaf);
  var fallback = null;
  for (var i = 0; i < flattenedFolders.length; i++) {
    var folder = flattenedFolders[i];
    if (!namesEqual(folder.name, leaf)) continue;
    if (ancestorsMatch(folder.parent, parts.slice(0, -1))) {
      if (folder.name === leaf) return folder;
      if (fallback === null) fallback = folder;
    }
  }
  return fallback;
}

/**
 * A project by name ("Community Outreach") or folder-qualified path
 * ("Work/Community Outreach"); the components before the last are the folder
 * ancestry, nearest first from the right.
 */
function resolveProjectByPath(raw) {
  var parts = splitPath(raw);
  if (parts.length === 0) return null;
  var name = parts[parts.length - 1];
  if (parts.length === 1) return firstByName(flattenedProjects, name);
  var fallback = null;
  for (var i = 0; i < flattenedProjects.length; i++) {
    var project = flattenedProjects[i];
    if (!namesEqual(project.name, name)) continue;
    if (ancestorsMatch(project.parentFolder, parts.slice(0, -1))) {
      if (project.name === name) return project;
      if (fallback === null) fallback = project;
    }
  }
  return fallback;
}

/** True when `folder` and its parents are named `names` from the right. */
function ancestorsMatch(folder, names) {
  var current = folder;
  for (var i = names.length - 1; i >= 0; i--) {
    if (!current || !namesEqual(current.name, names[i])) return false;
    current = current.parent;
  }
  return true;
}

/**
 * Set a repetition rule compiled on the TypeScript side (#116) and read it
 * back. `compiled` is { recurrence, schedule, anchorKey|null, catchUp,
 * isProject }: schedule and anchor are explicit constructor arguments in Omni
 * Automation, which is why this is not the AppleScript record (that stored
 * every fixed repeat as due-anchored). A null anchorKey means "default from
 * the item's dates as they now stand", so call this after the date writes.
 * Returns the anchor word actually stored: 'due' | 'defer' | 'planned'.
 */
function applyRepetition(item, compiled) {
  if (!Task.AnchorDateKey) throw new Error('repetition: setting a repeat requires OmniFocus 4.7 or later');
  var x = item.project ? item.project : item;
  var K = Task.AnchorDateKey;
  var S = Task.RepetitionScheduleType[compiled.schedule];
  var a;
  if (compiled.anchorKey) {
    a = K[compiled.anchorKey];
  } else if (compiled.isProject) {
    a = x.dueDate ? K.DueDate : K.DeferDate;
  } else {
    a = x.dueDate ? K.DueDate : x.deferDate ? K.DeferDate : x.plannedDate ? K.PlannedDate : K.DeferDate;
  }
  x.repetitionRule = new Task.RepetitionRule(compiled.recurrence, null, S, a, compiled.catchUp);
  var r = x.repetitionRule;
  if (!r || r.ruleString !== compiled.recurrence || r.scheduleType !== S || r.anchorDateKey !== a ||
      r.catchUpAutomatically !== compiled.catchUp) {
    throw new Error('repetition: rule did not read back as written');
  }
  return a === K.DueDate ? 'due' : a === K.DeferDate ? 'defer' : 'planned';
}

/** The changedProperties label for a repetition write, naming the stored anchor. */
function repetitionLabel(compiled, anchorWord) {
  if (compiled.method === 'fixed') {
    return 'repetition (fixed, from ' + anchorWord + ' date' + (compiled.catchUp ? ', catch up' : '') + ')';
  }
  return compiled.method === 'start-after-completion'
    ? 'repetition (start after completion)'
    : 'repetition (due after completion)';
}

/**
 * Set a project's review interval (#139) and read it back. The getter returns
 * a copy and the setter accepts only a Project.ReviewInterval, so the copy is
 * mutated and assigned back. `unit` is already plural ('weeks').
 */
function applyReviewInterval(project, spec) {
  var r = project.reviewInterval;
  r.steps = spec.steps;
  r.unit = spec.unit;
  project.reviewInterval = r;
  var b = project.reviewInterval;
  if (!b || b.steps !== spec.steps || b.unit !== spec.unit) {
    throw new Error('review interval: did not read back as written');
  }
}

/** Attach each named tag, creating missing ones; a tag that fails is skipped. */
function addTagsByName(item, names) {
  for (var i = 0; i < names.length; i++) {
    try {
      item.addTag(ensureTag(names[i]));
    } catch (e) {
      // Could not create or add the tag; the AppleScript write swallowed this too.
    }
  }
}

/**
 * Where a new task actually landed, for add_omnifocus_task's `placement`:
 * 'parent' when it sits under the parent the caller asked for, 'project' when
 * it is at a project's top level (or under some other task), 'inbox'
 * otherwise. If the hierarchy cannot be read, fall back to what was requested.
 */
function placementOf(task, requestedParent, requestedProject) {
  try {
    var container = task.parent;
    if (requestedParent && container === requestedParent) return 'parent';
    if (task.inInbox || !container) return task.containingProject ? 'project' : 'inbox';
    return 'project';
  } catch (e) {
    return requestedProject ? 'project' : 'inbox';
  }
}
