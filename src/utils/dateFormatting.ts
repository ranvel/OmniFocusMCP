/**
 * Caller-supplied dates, parsed once as local wall-clock time and handed to
 * the OmniJS write scripts as components.
 */

/**
 * Parse a caller-supplied date the way it is written to OmniFocus: as LOCAL
 * wall-clock time. `new Date("2026-04-10")` is UTC midnight, which is the
 * previous evening anywhere behind UTC, so date-only strings get T00:00:00.
 *
 * Every place that turns caller input into a Date — the write AND any echo of
 * it in a result — must go through this. The add tools' success text once used
 * `new Date(args.dueDate)` directly and reported a task due 9/29 as "due on
 * 9/28/2026" while storing 9/29 correctly; callers trust that text.
 */
export function parseInputDate(isoDateString: string): Date {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(isoDateString)
    ? isoDateString + 'T00:00:00'
    : isoDateString;
  return new Date(normalized);
}

/**
 * A local wall-clock date as components, the form the OmniJS write scripts
 * take (`dateFromParts` in `_writeHelpers.js`). Sending components rather than
 * an ISO string keeps the calendar day the caller wrote: a string parsed with
 * `new Date()` inside OmniFocus would be read as UTC midnight (#91).
 */
export interface DateParts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

export function toDateParts(isoDateString: string): DateParts {
  const date = parseInputDate(isoDateString);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date string: ${isoDateString}`);
  }
  return {
    y: date.getFullYear(),
    m: date.getMonth() + 1,
    d: date.getDate(),
    h: date.getHours(),
    mi: date.getMinutes(),
    s: date.getSeconds(),
  };
}

/**
 * An edit's date field: `undefined` leaves the date alone, `''` clears it
 * (null in the payload), anything else is parsed.
 */
export function editDateParam(value: string | undefined): DateParts | null | undefined {
  if (value === undefined) return undefined;
  if (value === '') return null;
  return toDateParts(value);
}
