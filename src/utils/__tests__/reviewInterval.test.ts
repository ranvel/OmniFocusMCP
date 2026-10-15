import { describe, it, expect } from 'vitest';
import {
  compileReviewInterval,
  describeReviewInterval,
  ReviewIntervalSpecError,
  type ReviewIntervalSpec,
} from '../reviewInterval.js';
import { _testExports } from '../../tools/primitives/queryOmnifocus.js';

/**
 * compileReviewInterval is the TypeScript half of a review-interval write: it
 * validates the spec and gives `applyReviewInterval` (in _writeHelpers.js,
 * tested under the OmniJS fake in writeHelpers.test.ts) the plural unit
 * OmniFocus expects.
 */
describe('compileReviewInterval (#139)', () => {
  it.each([
    [{ steps: 2, unit: 'week' }, 2, 'weeks'],
    [{ steps: 1, unit: 'month' }, 1, 'months'],
    [{ steps: 10, unit: 'day' }, 10, 'days'],
    [{ steps: 1, unit: 'year' }, 1, 'years'],
  ] as const)('compiles %o to the plural OmniJS unit', (spec, steps, unit) => {
    expect(compileReviewInterval(spec as ReviewIntervalSpec)).toEqual({ steps, unit });
  });

  it.each([
    [{ steps: 0, unit: 'week' }],
    [{ steps: 1.5, unit: 'week' }],
    [{ steps: 2, unit: 'fortnight' }],
  ])('rejects malformed spec %o before anything is sent', spec => {
    expect(() => compileReviewInterval(spec as any)).toThrow(ReviewIntervalSpecError);
  });
});

describe('review interval round-trip with query_omnifocus', () => {
  // Pull the formatter query_omnifocus actually ships and run it on the
  // {steps, unit} object OmniFocus returns.
  const script = _testExports.generateQueryScript({ entity: 'projects', fields: ['reviewInterval'] });
  const src = script.match(/function formatReviewInterval\(ri\) \{[\s\S]*?\n\s*\}\n/)![0];
  const format = new Function(`${src}; return formatReviewInterval;`)() as (ri: unknown) => string | null;

  it.each([
    [{ steps: 1, unit: 'week' }],
    [{ steps: 2, unit: 'week' }],
    [{ steps: 1, unit: 'day' }],
    [{ steps: 6, unit: 'month' }],
    [{ steps: 1, unit: 'year' }],
  ] as const)('%o reads back as describeReviewInterval says', spec => {
    const omni = { steps: spec.steps, unit: spec.unit + 's' };
    expect(format(omni)).toBe(describeReviewInterval(spec as ReviewIntervalSpec));
  });

  it('renders the live shape rather than null (the old formatter read fields that do not exist)', () => {
    expect(format({ steps: 2, unit: 'weeks' })).toBe('2 weeks');
    expect(format(null)).toBeNull();
  });
});
