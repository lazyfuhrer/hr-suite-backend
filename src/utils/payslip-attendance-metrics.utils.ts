import { AttendanceHalfDayNoPunchPenalty } from '../models/AttendanceHalfDayNoPunchPenalty';
import { AttendanceLog } from '../models/AttendanceLog';
import { LeaveRequest } from '../models/LeaveRequest';
import { User } from '../models/User';
import {
  fetchEffectiveHolidayDateSet,
  isUserAttendanceScheduledDay,
  resolveEffectiveAttendanceSchedule,
  coerceDepartmentWorkingDays,
  weekdayNameFromISTDateStr,
} from './attendance-schedule.utils';
import { formatDateLocal, normalizeDate } from './date.utils';
import { fetchPrimaryManagedDepartmentScheduleByManagerIds } from './department-manager.utils';

export type PayslipAttendanceMetrics = {
  standardDays: number;
  workingDays: number;
  lopDays: number;
};

/** Marker coordinates for dev/test rows created by seed-simulated-attendance script (cleanup target). */
export const SIMULATED_ATTENDANCE_MARKER_LAT = '12.97160000';
export const SIMULATED_ATTENDANCE_MARKER_LNG = '77.59460000';

export type PayslipScheduleBundle = {
  orgId: string;
  userId: string;
  payrollMonth: number;
  payrollYear: number;
  monthStart: string;
  monthEnd: string;
  scheduledDates: Set<string>;
  dojStr: string;
};

const IST_WEEKDAY_MON_FRI = new Set(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY']);

/**
 * Mon–Fri in [monthStart, monthEnd] excluding org holidays (IST calendar walk).
 * Used when department schedule yields zero scheduled days (e.g. DOJ after month, or bad working_days).
 */
export function buildFallbackWeekdayDatesExcludingHolidays(
  monthStart: string,
  monthEnd: string,
  holidaySet: Set<string>,
): string[] {
  const out: string[] = [];
  let current = new Date(`${monthStart}T12:00:00+05:30`);
  const end = new Date(`${monthEnd}T12:00:00+05:30`);
  while (current <= end) {
    const dateStr = formatDateLocal(current);
    if (!holidaySet.has(dateStr)) {
      const wd = weekdayNameFromISTDateStr(dateStr);
      if (IST_WEEKDAY_MON_FRI.has(wd)) {
        out.push(dateStr);
      }
    }
    current = new Date(current.getTime() + 24 * 60 * 60 * 1000);
  }
  return out.sort();
}

/**
 * Scheduled days without a punch, accounting for fractional approved leave coverage.
 * When a penalty row records explicit LOP for a date, that value is used instead of (1 - coverage).
 */
export function countLopDaysWithLeaveCoverage(params: {
  scheduledDates: Set<string>;
  punchDates: Set<string>;
  leaveCoverageByDate: Map<string, number>;
  penaltyLopByDate: Map<string, number>;
}): number {
  let n = 0;
  for (const d of params.scheduledDates) {
    if (params.punchDates.has(d)) continue;

    const explicitPenaltyLop = params.penaltyLopByDate.get(d);
    if (explicitPenaltyLop != null && explicitPenaltyLop > 0) {
      n += explicitPenaltyLop;
      continue;
    }

    const coverage = params.leaveCoverageByDate.get(d) ?? 0;
    n += Math.max(0, 1 - coverage);
  }
  return n;
}

/** @deprecated Use countLopDaysWithLeaveCoverage for fractional half-day leave support. */
export function countLopDaysExcludingApprovedLeave(params: {
  scheduledDates: Set<string>;
  punchDates: Set<string>;
  approvedLeaveDatesOnSchedule: Set<string>;
}): number {
  const leaveCoverageByDate = new Map<string, number>();
  for (const d of params.approvedLeaveDatesOnSchedule) {
    leaveCoverageByDate.set(d, 1);
  }
  return countLopDaysWithLeaveCoverage({
    scheduledDates: params.scheduledDates,
    punchDates: params.punchDates,
    leaveCoverageByDate,
    penaltyLopByDate: new Map(),
  });
}

export function buildApprovedLeaveCoverageByDate(params: {
  leaveRows: Array<{
    start_date?: string | Date | null;
    end_date?: string | Date | null;
    day_session?: string | null;
    total_days?: number | null;
  }>;
  scheduledDates: Set<string>;
}): Map<string, number> {
  const coverageByDate = new Map<string, number>();

  for (const row of params.leaveRows) {
    const start = normalizeDate(row.start_date ?? null);
    const end = normalizeDate(row.end_date ?? null);
    if (!start || !end) continue;

    let dayFactor = 1;
    if (row.day_session === 'FIRST_HALF' || row.day_session === 'SECOND_HALF') {
      dayFactor = 0.5;
    } else if (row.total_days != null && row.total_days < 1) {
      dayFactor = row.total_days;
    }

    for (const d of params.scheduledDates) {
      if (d >= start && d <= end) {
        coverageByDate.set(d, (coverageByDate.get(d) ?? 0) + dayFactor);
      }
    }
  }

  return coverageByDate;
}

/**
 * Loads department schedule + org holidays and builds the set of attendance-scheduled
 * calendar dates in the payroll month (on or after DOJ). Used by payslip metrics and
 * attendance simulation scripts.
 */
export async function loadPayslipScheduleBundle(params: {
  orgId: string;
  userId: string;
  payrollMonth: number;
  payrollYear: number;
  /**
   * When true, days before `date_of_joining` are still treated as scheduled (dev / seed only).
   * Production payslips must omit this or pass false.
   */
  ignoreDateOfJoining?: boolean;
  /**
   * When true and the normal department schedule yields zero scheduled days, use Mon–Fri
   * (excluding org holidays) for the month. Dev / seed only.
   */
  useWeekdayFallbackIfEmpty?: boolean;
}): Promise<PayslipScheduleBundle | null> {
  const {
    orgId,
    userId,
    payrollMonth,
    payrollYear,
    ignoreDateOfJoining = false,
    useWeekdayFallbackIfEmpty = false,
  } = params;
  const targetMonth = Math.min(12, Math.max(1, Number(payrollMonth || 1)));
  const targetYear = Number(payrollYear || new Date().getFullYear());

  const daysInMonth = new Date(targetYear, targetMonth, 0).getDate();
  const monthStart = `${targetYear}-${String(targetMonth).padStart(2, '0')}-01`;
  const monthEnd = `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;

  const userRow = await User.query()
    .alias('u')
    .leftJoin('departments as d', 'd.id', 'u.department_id')
    .where('u.id', userId)
    .where('u.org_id', orgId)
    .select(
      'u.role',
      'u.department_id',
      'u.date_of_joining',
      'd.working_days as department_working_days',
    )
    .first();

  if (!userRow) {
    return null;
  }

  const role = (userRow as { role?: string }).role ?? null;
  const departmentId = (userRow as { department_id?: string | null }).department_id ?? null;
  const deptWdRaw = (userRow as { department_working_days?: unknown }).department_working_days;
  const deptWdArray = coerceDepartmentWorkingDays(deptWdRaw);
  const dojStr = normalizeDate(
    (userRow as { date_of_joining?: string | null }).date_of_joining ?? null,
  );

  const managedMap = await fetchPrimaryManagedDepartmentScheduleByManagerIds(orgId, [userId]);
  const managedFallback = managedMap.get(String(userId));

  const eff = resolveEffectiveAttendanceSchedule(
    {
      role,
      department_id: departmentId,
      department_working_days: deptWdArray,
    },
    managedFallback,
  );

  const holidaySet = await fetchEffectiveHolidayDateSet(orgId, userId, monthStart, monthEnd);
  const effectiveDeptId = eff.departmentId;
  const scheduleWorkingDays = eff.workingDays;

  const scheduledDates = new Set<string>();
  const startIST = new Date(`${monthStart}T00:00:00+05:30`);
  const endIST = new Date(`${monthEnd}T23:59:59+05:30`);
  let current = new Date(startIST);

  while (current <= endIST) {
    const dateStr = formatDateLocal(current);
    if (!ignoreDateOfJoining && dojStr && dateStr < dojStr) {
      current = new Date(current.getTime() + 24 * 60 * 60 * 1000);
      continue;
    }
    if (
      isUserAttendanceScheduledDay({
        dateStr,
        holidaySet,
        departmentId: effectiveDeptId,
        workingDays: scheduleWorkingDays,
      })
    ) {
      scheduledDates.add(dateStr);
    }
    current = new Date(current.getTime() + 24 * 60 * 60 * 1000);
  }

  if (scheduledDates.size === 0 && useWeekdayFallbackIfEmpty) {
    for (const d of buildFallbackWeekdayDatesExcludingHolidays(monthStart, monthEnd, holidaySet)) {
      scheduledDates.add(d);
    }
  }

  return {
    orgId,
    userId,
    payrollMonth: targetMonth,
    payrollYear: targetYear,
    monthStart,
    monthEnd,
    scheduledDates,
    dojStr,
  };
}

/**
 * Standard days = attendance-scheduled dates in the payroll month (dept working week − org holidays),
 * on or after date_of_joining. Working days = distinct dates with clock-in on those scheduled days.
 * LOP = scheduled days with no punch and no APPROVED leave covering that date (leave is not unpaid absence).
 */
export async function computePayslipAttendanceMetrics(params: {
  orgId: string;
  userId: string;
  payrollMonth: number;
  payrollYear: number;
  ignoreDateOfJoining?: boolean;
  useWeekdayFallbackIfEmpty?: boolean;
}): Promise<PayslipAttendanceMetrics> {
  const bundle = await loadPayslipScheduleBundle(params);
  if (!bundle) {
    return { standardDays: 0, workingDays: 0, lopDays: 0 };
  }

  const { orgId, userId, monthStart, monthEnd, scheduledDates, dojStr } = bundle;
  const standardDays = scheduledDates.size;

  const logRows = await AttendanceLog.query()
    .where('user_id', userId)
    .where('org_id', orgId)
    .whereBetween('date', [monthStart, monthEnd])
    .whereNotNull('clock_in_time')
    .select('date');

  const punchDates = new Set<string>();
  for (const row of logRows as { date?: string | Date }[]) {
    const raw = row.date;
    const normalized =
      raw instanceof Date ? formatDateLocal(raw) : typeof raw === 'string' ? raw.slice(0, 10) : '';
    if (!normalized || !scheduledDates.has(normalized)) continue;
    if (dojStr && normalized < dojStr) continue;
    punchDates.add(normalized);
  }

  const workingDays = punchDates.size;

  const leaveRows = await LeaveRequest.query()
    .where('org_id', orgId)
    .where('user_id', userId)
    .where('status', 'APPROVED')
    .where((qb) => {
      qb.whereBetween('start_date', [monthStart, monthEnd])
        .orWhereBetween('end_date', [monthStart, monthEnd])
        .orWhere((subQb) => {
          subQb.where('start_date', '<=', monthStart).where('end_date', '>=', monthEnd);
        });
    })
    .select('start_date', 'end_date', 'day_session', 'total_days');

  const leaveCoverageByDate = buildApprovedLeaveCoverageByDate({
    leaveRows: leaveRows as Array<{
      start_date?: string | Date | null;
      end_date?: string | Date | null;
      day_session?: string | null;
      total_days?: number | null;
    }>,
    scheduledDates,
  });

  const penaltyRows = await AttendanceHalfDayNoPunchPenalty.query()
    .where('org_id', orgId)
    .where('user_id', userId)
    .whereBetween('penalty_date', [monthStart, monthEnd])
    .where('lop_days', '>', 0)
    .select('penalty_date', 'lop_days');

  const penaltyLopByDate = new Map<string, number>();
  for (const row of penaltyRows as Array<{ penalty_date?: string | Date; lop_days?: number }>) {
    const d = normalizeDate(row.penalty_date ?? null);
    if (!d || !scheduledDates.has(d)) continue;
    penaltyLopByDate.set(d, Number(row.lop_days ?? 0));
  }

  const lopDays = countLopDaysWithLeaveCoverage({
    scheduledDates,
    punchDates,
    leaveCoverageByDate,
    penaltyLopByDate,
  });

  return { standardDays, workingDays, lopDays };
}
