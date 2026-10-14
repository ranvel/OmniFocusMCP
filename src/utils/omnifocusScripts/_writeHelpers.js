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
