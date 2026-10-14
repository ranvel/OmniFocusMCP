/**
 * Small normalizations the write primitives apply before handing parameters
 * to their OmniJS scripts.
 */

/**
 * Names (task, project, tag) are single-line in OmniFocus; the AppleScript
 * writes this replaced turned any newline in a name into a space, and callers
 * have come to rely on a pasted multi-line title not producing a multi-line
 * name. Notes are left alone.
 */
export function flattenName(name: string): string {
  return name.replace(/\r\n|\r|\n/g, ' ');
}
