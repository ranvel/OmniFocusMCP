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
