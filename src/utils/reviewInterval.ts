/**
 * Setting a project's review interval (issue #139).
 *
 * Omni Automation exposes `Project.reviewInterval` as a `Project.ReviewInterval`
 * value with `steps` and `unit`. Three behaviors, all verified live, shape this:
 * - The getter returns a copy. Mutating it in place changes nothing; the
 *   mutated copy has to be assigned back.
 * - A plain `{steps, unit}` object is rejected; only a `Project.ReviewInterval`
 *   is accepted, so the copy is the only way to get one.
 * - The unit strings are plural (`'weeks'`). A singular or unknown unit is not
 *   an error: OmniFocus silently keeps the old unit and resets steps to 1, and
 *   `steps: 0` silently becomes 1. Hence the read-back below: a write that
 *   lands as something else must fail, not report success.
 */

export type ReviewUnit = 'day' | 'week' | 'month' | 'year';

export interface ReviewIntervalSpec {
  steps: number;
  unit: ReviewUnit;
}

const OMNIJS_UNIT: Record<ReviewUnit, string> = {
  day: 'days',
  week: 'weeks',
  month: 'months',
  year: 'years',
};

export class ReviewIntervalSpecError extends Error {}

/**
 * The interval as query_omnifocus's `reviewInterval` field renders it
 * ("1 week", "2 weeks"), so a write can be compared with what reads back.
 */
export function describeReviewInterval(spec: ReviewIntervalSpec): string {
  return `${spec.steps} ${spec.unit}${spec.steps === 1 ? '' : 's'}`;
}

/**
 * A spec validated and compiled for `applyReviewInterval` in `_writeHelpers.js`,
 * which assigns the interval and reads it back.
 */
export interface CompiledReviewInterval {
  steps: number;
  unit: string;
}

export function compileReviewInterval(spec: ReviewIntervalSpec): CompiledReviewInterval {
  const unit = OMNIJS_UNIT[spec.unit];
  if (!unit) {
    throw new ReviewIntervalSpecError(
      `Invalid review interval unit "${spec.unit}". Expected one of: day, week, month, year.`
    );
  }
  if (!Number.isInteger(spec.steps) || spec.steps < 1) {
    throw new ReviewIntervalSpecError(
      `Invalid review interval steps "${spec.steps}". Expected a positive whole number.`
    );
  }
  return { steps: spec.steps, unit };
}
