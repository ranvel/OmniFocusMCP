import { describe, it, expect } from 'vitest';
import { toDateParts, editDateParam, parseInputDate } from './dateFormatting.js';

describe('parseInputDate', () => {
  it('reads a date-only string as local midnight, not UTC', () => {
    const d = parseInputDate('2026-04-10');
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours()]).toEqual([2026, 4, 10, 0]);
  });
});

describe('toDateParts (OmniJS writes)', () => {
  it('date-only string uses the local calendar day at midnight, not UTC', () => {
    expect(toDateParts('2026-04-10')).toEqual({ y: 2026, m: 4, d: 10, h: 0, mi: 0, s: 0 });
  });

  it('datetime string preserves the specified time', () => {
    expect(toDateParts('2026-04-10T17:30:15')).toEqual({ y: 2026, m: 4, d: 10, h: 17, mi: 30, s: 15 });
  });

  it('throws on invalid date string', () => {
    expect(() => toDateParts('not-a-date')).toThrow('Invalid date string: not-a-date');
  });

  /**
   * Issue #91: the AppleScript date builder scaffolded off `current date`, so a
   * date written on the 29th-31st toward a shorter month rolled forward a month.
   * Components carry no "today" at all; `dateFromParts` in _writeHelpers.js
   * builds `new Date(y, m-1, d, …)` from them (tested under a frozen clock in
   * writeHelpers.test.ts).
   */
  it('targets a short month without depending on today (#91)', () => {
    expect(toDateParts('2026-11-01')).toMatchObject({ y: 2026, m: 11, d: 1 });
    expect(toDateParts('2026-02-28')).toMatchObject({ y: 2026, m: 2, d: 28 });
  });

  it('editDateParam distinguishes untouched, cleared and set', () => {
    expect(editDateParam(undefined)).toBeUndefined();
    expect(editDateParam('')).toBeNull();
    expect(editDateParam('2026-04-10')).toEqual({ y: 2026, m: 4, d: 10, h: 0, mi: 0, s: 0 });
  });
});
