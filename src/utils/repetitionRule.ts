/**
 * Repetition rule support (issue #116).
 *
 * OmniFocus stores a repeat as an ICS recurrence string plus a method. Callers
 * shouldn't have to hand-write RRULEs — a mistyped `INTERVAL` is silent and
 * costly (a live task was found scheduled `FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH`
 * against a note reading "2x/week", i.e. half the intended rate, undetected for
 * months). So the tool surface takes a typed shape and this module compiles it.
 *
 * Scope is set by a census of a real, heavily-used database (78 rules): every
 * rule in the wild was a simple interval or a weekday set. Zero used BYSETPOS
 * ("third Tuesday"), BYMONTHDAY, COUNT, or UNTIL — so those are deliberately
 * unsupported rather than half-implemented.
 */

export type RepetitionMethodName = 'fixed' | 'start-after-completion' | 'due-after-completion';
export type RepetitionUnit = 'day' | 'week' | 'month' | 'year';
export type Weekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

export interface RepetitionSpec {
  method: RepetitionMethodName;
  unit: RepetitionUnit;
  steps?: number;
  /** Week-unit only; compiles to BYDAY. */
  weekdays?: Weekday[];
  /**
   * `fixed` only: which date the schedule counts from. Omitted, it is the due
   * date if the item has one, else the defer date, else the planned date — see
   * `applyRepetition` in `_writeHelpers.js` for why that default matters.
   */
  anchor?: RepetitionAnchor;
  /** `fixed` only: OmniFocus's "catch up automatically". Default false. */
  catchUp?: boolean;
}

export type RepetitionAnchor = 'defer' | 'due' | 'planned';

const FREQ_BY_UNIT: Record<RepetitionUnit, string> = {
  day: 'DAILY',
  week: 'WEEKLY',
  month: 'MONTHLY',
  year: 'YEARLY',
};

/**
 * How each method is written through Omni Automation. OmniFocus 4.7 split the
 * old single "method" into a schedule type plus an anchor date; the two
 * after-completion methods imply their anchor, `fixed` needs one chosen.
 * Verified by round-trip: each combination reads back as the OMNIJS_METHOD
 * value below.
 */
const SCHEDULE: Record<RepetitionMethodName, 'Regularly' | 'FromCompletion'> = {
  fixed: 'Regularly',
  'start-after-completion': 'FromCompletion',
  'due-after-completion': 'FromCompletion',
};

const ANCHOR_KEY: Record<RepetitionAnchor, string> = {
  defer: 'DeferDate',
  due: 'DueDate',
  planned: 'PlannedDate',
};

const IMPLIED_ANCHOR: Partial<Record<RepetitionMethodName, RepetitionAnchor>> = {
  'start-after-completion': 'defer',
  'due-after-completion': 'due',
};

/** How the method reads back from query_omnifocus (#115), for verification. */
export const OMNIJS_METHOD: Record<RepetitionMethodName, string> = {
  fixed: 'Fixed',
  'start-after-completion': 'DeferUntilDate',
  'due-after-completion': 'DueDate',
};

const VALID_WEEKDAYS: readonly Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

export class RepetitionSpecError extends Error {}

/**
 * Compile a spec into an ICS recurrence string.
 *
 * Throws RepetitionSpecError on anything malformed. Failing loudly matters here:
 * a silently-dropped or silently-wrong repeat is exactly the failure this
 * feature exists to remove, so an invalid spec must never degrade into "created
 * without a repeat, reported success".
 */
export function compileRecurrence(spec: RepetitionSpec): string {
  const freq = FREQ_BY_UNIT[spec.unit];
  if (!freq) {
    throw new RepetitionSpecError(
      `Invalid repeat unit "${spec.unit}". Expected one of: day, week, month, year.`
    );
  }
  if (!(spec.method in SCHEDULE)) {
    throw new RepetitionSpecError(
      `Invalid repeat method "${spec.method}". Expected one of: fixed, start-after-completion, due-after-completion.`
    );
  }

  if (spec.method !== 'fixed' && (spec.anchor !== undefined || spec.catchUp !== undefined)) {
    throw new RepetitionSpecError(
      `anchor and catchUp only apply to method "fixed"; "${spec.method}" already implies its ` +
        `anchor (${IMPLIED_ANCHOR[spec.method]} date, counted from completion).`
    );
  }
  if (spec.anchor !== undefined && !(spec.anchor in ANCHOR_KEY)) {
    throw new RepetitionSpecError(
      `Invalid repeat anchor "${spec.anchor}". Expected one of: defer, due, planned.`
    );
  }

  const steps = spec.steps ?? 1;
  if (!Number.isInteger(steps) || steps < 1) {
    throw new RepetitionSpecError(
      `Invalid repeat steps "${spec.steps}". Expected a positive whole number.`
    );
  }

  const parts = [`FREQ=${freq}`];
  // INTERVAL=1 is the ICS default; omitting it keeps rules byte-identical to
  // what OmniFocus itself writes for a plain weekly repeat, which matters when
  // comparing a written rule against one set by hand in the inspector.
  if (steps > 1) parts.push(`INTERVAL=${steps}`);

  if (spec.weekdays && spec.weekdays.length > 0) {
    if (spec.unit !== 'week') {
      throw new RepetitionSpecError(
        `weekdays is only valid with unit "week" (got "${spec.unit}"). For monthly or yearly ` +
          `positional rules ("third Tuesday"), set the repeat in OmniFocus directly — not yet supported here.`
      );
    }
    const seen = new Set<string>();
    for (const day of spec.weekdays) {
      if (!VALID_WEEKDAYS.includes(day)) {
        throw new RepetitionSpecError(
          `Invalid weekday "${day}". Expected two-letter codes: ${VALID_WEEKDAYS.join(', ')}.`
        );
      }
      if (seen.has(day)) {
        throw new RepetitionSpecError(`Duplicate weekday "${day}" in repeat.`);
      }
      seen.add(day);
    }
    // Emit in calendar order rather than the caller's order, so the same set
    // always produces the same rule string and comparisons are stable.
    const ordered = VALID_WEEKDAYS.filter(d => seen.has(d));
    parts.push(`BYDAY=${ordered.join(',')}`);
  }

  return parts.join(';');
}

/**
 * A repetition spec compiled for the OmniJS write helpers (`applyRepetition`
 * in `_writeHelpers.js`). Schedule type and anchor are the explicit
 * constructor arguments Omni Automation takes since OmniFocus 4.7; a null
 * `anchorKey` means "default from the item's dates at write time".
 *
 * Why not AppleScript's `set repetition rule of X to {repetition method:…,
 * recurrence:…}`: that record has no anchor field, and OmniFocus stores every
 * `fixed repetition` written that way as anchored on the DUE date — whatever
 * dates the item actually has. A due-anchored repeat on an item with no due
 * date grows one on completion; one live case came back deferred past its own
 * new due date. The helper also reads the stored rule back and fails loudly
 * on a mismatch: a repeat that silently lands as something other than what
 * was asked is the failure this module exists to remove.
 */
export interface CompiledRepetition {
  method: RepetitionMethodName;
  recurrence: string;
  schedule: 'Regularly' | 'FromCompletion';
  anchorKey: string | null;
  catchUp: boolean;
  isProject: boolean;
}

/**
 * Validate and compile a spec. Throws RepetitionSpecError on anything
 * malformed, so an invalid repeat never degrades into "created without one".
 */
export function compileRepetitionSpec(
  spec: RepetitionSpec,
  options: { isProject: boolean }
): CompiledRepetition {
  const recurrence = compileRecurrence(spec);
  if (options.isProject && spec.anchor === 'planned') {
    throw new RepetitionSpecError(
      'anchor "planned" is not available for projects (projects have no planned date). Use "defer" or "due".'
    );
  }
  const fixedAnchor = spec.anchor ?? IMPLIED_ANCHOR[spec.method];
  return {
    method: spec.method,
    recurrence,
    schedule: SCHEDULE[spec.method],
    anchorKey: fixedAnchor ? ANCHOR_KEY[fixedAnchor] : null,
    catchUp: spec.method === 'fixed' && spec.catchUp === true,
    isProject: options.isProject,
  };
}

/**
 * Human-readable rendering for tool results, so a caller can confirm what was
 * set without decoding an RRULE.
 */
export function describeRepetition(spec: RepetitionSpec): string {
  const steps = spec.steps ?? 1;
  const every = steps === 1 ? `every ${spec.unit}` : `every ${steps} ${spec.unit}s`;
  const days =
    spec.weekdays && spec.weekdays.length > 0
      ? ` on ${VALID_WEEKDAYS.filter(d => spec.weekdays!.includes(d)).join(', ')}`
      : '';
  const from =
    spec.method === 'fixed'
      ? spec.anchor
        ? `on a fixed schedule from the ${spec.anchor} date`
        : 'on a fixed schedule from the due date (or defer date if none)'
      : spec.method === 'start-after-completion'
        ? 'starting after completion'
        : 'due after completion';
  return `${every}${days}, ${from}`;
}
