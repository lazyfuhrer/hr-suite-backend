import {
  fetchEffectiveHolidayDateSet,
  fetchEffectiveHolidayDateSetsForUsers,
  fetchOrgHolidayDateSet,
  isUserAttendanceScheduledDay,
  resolveEffectiveAttendanceSchedule,
  type EffectiveAttendanceSchedule,
} from './attendance-schedule.utils';
import { addCalendarDays, normalizeDate } from './date.utils';
import {
  fetchPrimaryManagedDepartmentScheduleByManagerIds,
  type PrimaryManagedDepartmentSchedule,
} from './department-manager.utils';
import type { LeaveDaySession } from '../models/LeaveRequest';

/**
 * Calculate the effective leave quota for a user in a specific year,
 * considering their date of joining.
 *
 * Logic:
 * - If user joined before the start of the year: Full Quota.
 * - If user joined after the end of the year: 0 Quota.
 * - If user joined during the year: Pro-rated based on remaining days in the year.
 *   - Formula: (AnnualQuota / DaysInYear) * RemainingDays
 *   - Rounding: Rounded to the nearest whole number.
 *
 * @param annualQuota The full annual quota for the leave type.
 * @param dateOfJoining The user's date of joining.
 * @param year The year for which to calculate the quota.
 * @returns The effective quota (number).
 */
export const calculateEffectiveQuota = (
  annualQuota: number,
  dateOfJoining: string | Date,
  year: number,
): number => {
  const doj = new Date(dateOfJoining);
  const startOfYear = new Date(Date.UTC(year, 0, 1)); // Jan 1st
  const endOfYear = new Date(Date.UTC(year, 11, 31)); // Dec 31st

  // Case 1: Joined after this year (Future employee relative to this year)
  if (doj > endOfYear) {
    return 0;
  }

  // Case 2: Joined before this year (Old employee)
  if (doj < startOfYear) {
    return annualQuota;
  }

  // Case 3: Joined during this year (New Joinee)
  // Calculate remaining days from DOJ (inclusive) to Dec 31st
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysInYear = (endOfYear.getTime() - startOfYear.getTime()) / msPerDay + 1;
  const remainingDays = (endOfYear.getTime() - doj.getTime()) / msPerDay + 1;

  // Validate non-negative (should be covered by cases above, but safety check)
  if (remainingDays <= 0) return 0;

  const rawQuota = (annualQuota / daysInYear) * remainingDays;

  // Round to nearest whole day so API responses always return integer quota values.
  return Math.round(rawQuota);
};

export type LeaveScheduleRowInput = {
  role?: string | null;
  department_id?: string | null;
  department_working_days?: unknown;
  user_id?: string;
};

/**
 * A half-day request covers a single working day, so it is worth 0.5 of whatever
 * the schedule-aware day count produced (0 when the date is not a working day).
 */
export function applyDaySessionFactor(days: number, daySession?: string | null): number {
  return daySession && daySession !== 'FULL' ? days * 0.5 : days;
}

/**
 * Combine the sessions of several approved leaves falling on one date.
 * Opposite halves together cover the whole day.
 */
export function mergeLeaveDaySessions(
  current: LeaveDaySession | undefined,
  incoming?: string | null,
): LeaveDaySession {
  const next = (incoming ?? 'FULL') as LeaveDaySession;
  if (!current) {
    return next;
  }
  return current === next ? current : 'FULL';
}

/**
 * Whether two requests whose date ranges already overlap also collide in time.
 * Half-day requests are always single-date, so opposite halves never collide.
 */
export function daySessionsCollide(a?: string | null, b?: string | null): boolean {
  const first = a ?? 'FULL';
  const second = b ?? 'FULL';
  if (first === 'FULL' || second === 'FULL') {
    return true;
  }
  return first === second;
}

export function resolveLeaveScheduleForRow(
  row: LeaveScheduleRowInput,
  managedScheduleByManagerId?: Map<string, PrimaryManagedDepartmentSchedule>,
): EffectiveAttendanceSchedule {
  const userId = row.user_id ? String(row.user_id) : '';
  const managedFallback =
    row.role === 'manager' && userId ? managedScheduleByManagerId?.get(userId) : undefined;

  return resolveEffectiveAttendanceSchedule(
    {
      role: row.role,
      department_id: row.department_id,
      department_working_days: row.department_working_days,
    },
    managedFallback
      ? {
          departmentId: managedFallback.departmentId,
          workingDays: managedFallback.workingDays,
        }
      : undefined,
  );
}

export function countLeaveDaysInRangeSync(params: {
  startDate: string;
  endDate: string;
  holidaySet: Set<string>;
  departmentId: string | null;
  workingDays: string[] | null;
}): number {
  const start = normalizeDate(params.startDate);
  const end = normalizeDate(params.endDate);
  if (!start || !end) {
    return 0;
  }

  if (start > end) {
    return 0;
  }

  let count = 0;
  let dateStr = start;

  while (dateStr <= end) {
    if (
      isUserAttendanceScheduledDay({
        dateStr,
        holidaySet: params.holidaySet,
        departmentId: params.departmentId,
        workingDays: params.workingDays,
      })
    ) {
      count++;
    }
    if (dateStr === end) {
      break;
    }
    dateStr = addCalendarDays(dateStr, 1);
  }

  return count;
}

export async function countLeaveDaysInRange(params: {
  org_id: string;
  startDate: string | Date;
  endDate: string | Date;
  departmentId: string | null;
  workingDays: string[] | null;
  holidaySet?: Set<string>;
  /** When set, holidays disabled for this user are excluded from the day count. */
  userId?: string | null;
}): Promise<number> {
  const startDate = normalizeDate(params.startDate);
  const endDate = normalizeDate(params.endDate);
  if (!startDate || !endDate) {
    return 0;
  }

  let holidaySet = params.holidaySet;
  if (!holidaySet) {
    holidaySet = params.userId
      ? await fetchEffectiveHolidayDateSet(params.org_id, String(params.userId), startDate, endDate)
      : await fetchOrgHolidayDateSet(params.org_id, startDate, endDate);
  }

  return countLeaveDaysInRangeSync({
    startDate,
    endDate,
    holidaySet,
    departmentId: params.departmentId,
    workingDays: params.workingDays,
  });
}

export function countLeaveDaysForRow(params: {
  row: LeaveScheduleRowInput & {
    start_date?: string | Date;
    end_date?: string | Date;
    day_session?: string | null;
  };
  holidaySet: Set<string>;
  /** When provided, prefer the set for `row.user_id` over the shared `holidaySet`. */
  holidaySetByUserId?: Map<string, Set<string>>;
  managedScheduleByManagerId?: Map<string, PrimaryManagedDepartmentSchedule>;
}): number {
  const schedule = resolveLeaveScheduleForRow(params.row, params.managedScheduleByManagerId);
  const startDate = normalizeDate(params.row.start_date);
  const endDate = normalizeDate(params.row.end_date);
  if (!startDate || !endDate) {
    return 0;
  }

  const userId = params.row.user_id ? String(params.row.user_id) : '';
  const holidaySet = (userId && params.holidaySetByUserId?.get(userId)) || params.holidaySet;

  const days = countLeaveDaysInRangeSync({
    startDate,
    endDate,
    holidaySet,
    departmentId: schedule.departmentId,
    workingDays: schedule.workingDays,
  });

  return applyDaySessionFactor(days, params.row.day_session);
}

export async function buildLeaveDaysContextForRows(
  org_id: string,
  rows: Array<LeaveScheduleRowInput & { start_date?: string | Date; end_date?: string | Date }>,
): Promise<{
  holidaySet: Set<string>;
  holidaySetByUserId: Map<string, Set<string>>;
  managedScheduleByManagerId: Map<string, PrimaryManagedDepartmentSchedule>;
}> {
  const bounds = minMaxLeaveDatesFromRows(rows);
  const userIds = [
    ...new Set(rows.map((r) => (r.user_id ? String(r.user_id) : '')).filter(Boolean)),
  ];

  const holidaySet = bounds
    ? await fetchOrgHolidayDateSet(org_id, bounds.minDate, bounds.maxDate)
    : new Set<string>();

  const holidaySetByUserId = bounds
    ? await fetchEffectiveHolidayDateSetsForUsers(org_id, userIds, bounds.minDate, bounds.maxDate)
    : new Map<string, Set<string>>();

  // Rows without user_id still need a set; fall back to org holidays.
  for (const userId of userIds) {
    if (!holidaySetByUserId.has(userId)) {
      holidaySetByUserId.set(userId, holidaySet);
    }
  }

  const managerIds = rows
    .filter((r) => r.role === 'manager' && r.user_id)
    .map((r) => String(r.user_id));

  const managedScheduleByManagerId = await fetchPrimaryManagedDepartmentScheduleByManagerIds(
    org_id,
    managerIds,
  );

  return { holidaySet, holidaySetByUserId, managedScheduleByManagerId };
}

export async function sumLeaveDaysForRequests(
  org_id: string,
  requests: Array<{
    start_date?: string | Date;
    end_date?: string | Date;
    day_session?: string | null;
  }>,
  scheduleRow: LeaveScheduleRowInput,
  managedScheduleByManagerId?: Map<string, PrimaryManagedDepartmentSchedule>,
): Promise<number> {
  if (requests.length === 0) {
    return 0;
  }

  const bounds = minMaxLeaveDatesFromRows(requests);
  if (!bounds) {
    return 0;
  }

  const userId = scheduleRow.user_id ? String(scheduleRow.user_id) : '';
  const holidaySet = userId
    ? await fetchEffectiveHolidayDateSet(org_id, userId, bounds.minDate, bounds.maxDate)
    : await fetchOrgHolidayDateSet(org_id, bounds.minDate, bounds.maxDate);
  const schedule = resolveLeaveScheduleForRow(scheduleRow, managedScheduleByManagerId);

  let total = 0;
  for (const req of requests) {
    const days = countLeaveDaysInRangeSync({
      startDate: normalizeDate(req.start_date) ?? '',
      endDate: normalizeDate(req.end_date) ?? '',
      holidaySet,
      departmentId: schedule.departmentId,
      workingDays: schedule.workingDays,
    });
    total += applyDaySessionFactor(days, req.day_session);
  }

  return total;
}

export function minMaxLeaveDatesFromRows(
  rows: Array<{ start_date?: string | Date; end_date?: string | Date }>,
): { minDate: string; maxDate: string } | null {
  let minDate: string | null = null;
  let maxDate: string | null = null;

  for (const row of rows) {
    const start = normalizeDate(row.start_date);
    const end = normalizeDate(row.end_date);
    if (!start || !end) continue;
    if (!minDate || start < minDate) minDate = start;
    if (!maxDate || end > maxDate) maxDate = end;
  }

  if (!minDate || !maxDate) {
    return null;
  }

  return { minDate, maxDate };
}
