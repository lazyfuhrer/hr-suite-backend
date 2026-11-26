import { Holiday } from '../models/Holiday';
import { UserHolidayOverride } from '../models/UserHolidayOverride';
import { formatDateLocal } from './date.utils';

/** Uppercase weekday names; aligned with department `working_days` storage. */
const IST_WEEKDAY_NAMES = [
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
] as const;

/** Default when department has no configured working_days (Mon–Fri). */
export const DEFAULT_DEPARTMENT_WORKING_DAYS = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
] as const;

/**
 * Normalize a calendar date to YYYY-MM-DD for holiday sets and leave day iteration.
 */
export function normalizeCalendarDate(value: string | Date | null | undefined): string {
  if (!value) return '';
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return value;
    }
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return formatDateLocal(parsed);
    }
    return value.slice(0, 10);
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatDateLocal(value);
  }
  return '';
}

/**
 * Parse department working_days from DB/API shapes (text[], JSON string, Postgres array literal).
 */
export function parseDepartmentWorkingDays(raw: unknown): string[] | null {
  if (raw == null) {
    return null;
  }

  let items: unknown[] | null = null;

  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        items = Array.isArray(parsed) ? parsed : null;
      } catch {
        items = null;
      }
    } else if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      const inner = trimmed.slice(1, -1).trim();
      items = inner ? inner.split(',').map((s) => s.trim().replace(/^"|"$/g, '')) : [];
    } else {
      items = [trimmed];
    }
  }

  if (!items || items.length === 0) {
    return null;
  }

  const normalized = items
    .map((d) => String(d).toUpperCase().trim())
    .filter((d) => IST_WEEKDAY_NAMES.includes(d as (typeof IST_WEEKDAY_NAMES)[number]));

  return normalized.length > 0 ? normalized : null;
}

/**
 * Weekday name for a calendar date interpreted in IST (matches attendance controllers).
 */
export function weekdayNameFromISTDateStr(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00+05:30`);
  if (Number.isNaN(d.getTime())) {
    return 'MONDAY';
  }
  return IST_WEEKDAY_NAMES[d.getUTCDay()];
}

export type OrgHolidayRangeResult = {
  dates: Set<string>;
  /** First non-empty title per calendar date (YYYY-MM-DD). */
  titleByDate: Map<string, string>;
};

type OrgHolidayRow = {
  id: string;
  date: string;
  title: string;
};

async function fetchOrgHolidayRowsInRange(
  org_id: string,
  startDate: string,
  endDate: string,
): Promise<OrgHolidayRow[]> {
  const rows = await Holiday.query()
    .where('org_id', org_id)
    .whereBetween('date', [startDate, endDate])
    .select('id', 'date', 'title');

  const result: OrgHolidayRow[] = [];
  for (const row of rows as { id?: string; date?: string | Date; title?: string | null }[]) {
    const normalized = normalizeCalendarDate(row.date ?? null);
    if (!normalized || !row.id) continue;
    result.push({
      id: String(row.id),
      date: normalized,
      title: row.title != null ? String(row.title).trim() : '',
    });
  }
  return result;
}

function buildHolidayRangeResult(
  rows: OrgHolidayRow[],
  disabledHolidayIds?: Set<string>,
): OrgHolidayRangeResult {
  const dates = new Set<string>();
  const titleByDate = new Map<string, string>();
  for (const row of rows) {
    if (disabledHolidayIds?.has(row.id)) continue;
    dates.add(row.date);
    if (row.title && !titleByDate.has(row.date)) {
      titleByDate.set(row.date, row.title);
    }
  }
  return { dates, titleByDate };
}

export async function fetchOrgHolidayDatesAndTitles(
  org_id: string,
  startDate: string,
  endDate: string,
): Promise<OrgHolidayRangeResult> {
  const rows = await fetchOrgHolidayRowsInRange(org_id, startDate, endDate);
  return buildHolidayRangeResult(rows);
}

export async function fetchOrgHolidayDateSet(
  org_id: string,
  startDate: string,
  endDate: string,
): Promise<Set<string>> {
  const { dates } = await fetchOrgHolidayDatesAndTitles(org_id, startDate, endDate);
  return dates;
}

/**
 * Holiday IDs explicitly disabled for each user (`enabled === false`).
 * Absence of a row means the org holiday still applies.
 */
export async function fetchDisabledHolidayIdsByUser(
  org_id: string,
  userIds: string[],
): Promise<Map<string, Set<string>>> {
  const uniqueUserIds = [...new Set(userIds.map(String).filter(Boolean))];
  const result = new Map<string, Set<string>>();
  for (const userId of uniqueUserIds) {
    result.set(userId, new Set());
  }
  if (uniqueUserIds.length === 0) {
    return result;
  }

  const rows = await UserHolidayOverride.query()
    .where('org_id', org_id)
    .whereIn('user_id', uniqueUserIds)
    .where('enabled', false)
    .select('user_id', 'holiday_id');

  for (const row of rows as { user_id?: string; holiday_id?: string }[]) {
    const userId = row.user_id ? String(row.user_id) : '';
    const holidayId = row.holiday_id ? String(row.holiday_id) : '';
    if (!userId || !holidayId) continue;
    let set = result.get(userId);
    if (!set) {
      set = new Set();
      result.set(userId, set);
    }
    set.add(holidayId);
  }

  return result;
}

export async function fetchDisabledHolidayIdsForUser(
  org_id: string,
  userId: string,
): Promise<Set<string>> {
  const byUser = await fetchDisabledHolidayIdsByUser(org_id, [userId]);
  return byUser.get(String(userId)) ?? new Set();
}

export async function fetchEffectiveHolidayDatesAndTitles(
  org_id: string,
  userId: string,
  startDate: string,
  endDate: string,
): Promise<OrgHolidayRangeResult> {
  const [rows, disabled] = await Promise.all([
    fetchOrgHolidayRowsInRange(org_id, startDate, endDate),
    fetchDisabledHolidayIdsForUser(org_id, userId),
  ]);
  return buildHolidayRangeResult(rows, disabled);
}

export async function fetchEffectiveHolidayDateSet(
  org_id: string,
  userId: string,
  startDate: string,
  endDate: string,
): Promise<Set<string>> {
  const { dates } = await fetchEffectiveHolidayDatesAndTitles(org_id, userId, startDate, endDate);
  return dates;
}

/**
 * Per-user holiday date sets for a range. Users with no overrides share the org set reference.
 */
export async function fetchEffectiveHolidayDateSetsForUsers(
  org_id: string,
  userIds: string[],
  startDate: string,
  endDate: string,
): Promise<Map<string, Set<string>>> {
  const uniqueUserIds = [...new Set(userIds.map(String).filter(Boolean))];
  const result = new Map<string, Set<string>>();
  if (uniqueUserIds.length === 0) {
    return result;
  }

  const [rows, disabledByUser] = await Promise.all([
    fetchOrgHolidayRowsInRange(org_id, startDate, endDate),
    fetchDisabledHolidayIdsByUser(org_id, uniqueUserIds),
  ]);

  const orgResult = buildHolidayRangeResult(rows);

  for (const userId of uniqueUserIds) {
    const disabled = disabledByUser.get(userId);
    if (!disabled || disabled.size === 0) {
      result.set(userId, orgResult.dates);
      continue;
    }
    result.set(userId, buildHolidayRangeResult(rows, disabled).dates);
  }

  return result;
}

export type AttendanceScheduleRowInput = {
  role?: string | null;
  department_id?: string | null;
  department_working_days?: unknown;
};

export type EffectiveAttendanceSchedule = {
  departmentId: string | null;
  workingDays: string[] | null;
};

/** Normalize `departments.working_days` from DB (array or JSON string) for schedule resolution. */
export function coerceDepartmentWorkingDays(raw: unknown): string[] | null {
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.map((s) => String(s).toUpperCase().trim()).filter(Boolean);
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((s) => String(s).toUpperCase().trim()).filter(Boolean);
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Prefer direct users.department_id + department working_days; for managers without a usable
 * direct schedule, use primary managed department (see fetchPrimaryManagedDepartmentScheduleByManagerIds).
 */
export function resolveEffectiveAttendanceSchedule(
  row: AttendanceScheduleRowInput,
  managedFallback: { departmentId: string; workingDays: string[] | null } | undefined,
): EffectiveAttendanceSchedule {
  const wdDirect = parseDepartmentWorkingDays(row.department_working_days);
  const deptIdDirect = row.department_id ? String(row.department_id) : null;
  const directUsable = Boolean(deptIdDirect && wdDirect && wdDirect.length > 0);

  if (directUsable) {
    return { departmentId: deptIdDirect, workingDays: wdDirect };
  }

  if (row.role === 'manager' && managedFallback) {
    const wdFb = parseDepartmentWorkingDays(managedFallback.workingDays);
    if (managedFallback.departmentId && wdFb && wdFb.length > 0) {
      return { departmentId: String(managedFallback.departmentId), workingDays: wdFb };
    }
  }

  return {
    departmentId: deptIdDirect,
    workingDays: wdDirect,
  };
}

function normalizeWorkingDays(workingDays: string[] | null | undefined): Set<string> | null {
  if (!workingDays || workingDays.length === 0) {
    return null;
  }
  return new Set(workingDays.map((d) => String(d).toUpperCase().trim()).filter(Boolean));
}

/**
 * Whether the user's department schedule treats this weekday as a working day
 * (ignores org holidays — use before subtracting holidays).
 */
export function isUserWorkingWeekdayByDepartment(
  departmentId: string | null | undefined,
  workingDays: string[] | null | undefined,
  dateStr: string,
): boolean {
  const weekday = weekdayNameFromISTDateStr(dateStr);
  const parsed = parseDepartmentWorkingDays(workingDays);
  const normalized = normalizeWorkingDays(parsed);
  if (!normalized || normalized.size === 0) {
    // Dept exists but schedule unset, or no dept: default Mon–Fri (exclude weekends).
    return (DEFAULT_DEPARTMENT_WORKING_DAYS as readonly string[]).includes(weekday);
  }
  return normalized.has(weekday);
}

/**
 * Full attendance applicability: org holiday or non-working weekday ⇒ false (omit day / no absent).
 * Leave on such days is skipped when this is checked before leave handling.
 */
export function isUserAttendanceScheduledDay(params: {
  dateStr: string;
  holidaySet: Set<string>;
  departmentId: string | null | undefined;
  workingDays: string[] | null | undefined;
}): boolean {
  const dateStr = normalizeCalendarDate(params.dateStr);
  if (!dateStr) {
    return false;
  }
  const { holidaySet, departmentId, workingDays } = params;
  if (holidaySet.has(dateStr)) {
    return false;
  }
  return isUserWorkingWeekdayByDepartment(departmentId, workingDays, dateStr);
}

/**
 * Omit a calendar date only when the user is not scheduled and has nothing to show
 * (no log, no pending correction). Voluntary punches on holidays/off-weekdays still appear.
 */
export function shouldOmitAttendanceCalendarDate(params: {
  dateStr: string;
  holidaySet: Set<string>;
  departmentId: string | null | undefined;
  workingDays: string[] | null | undefined;
  hasLog: boolean;
  hasPendingCorrection: boolean;
}): boolean {
  if (params.hasLog || params.hasPendingCorrection) {
    return false;
  }
  return !isUserAttendanceScheduledDay({
    dateStr: params.dateStr,
    holidaySet: params.holidaySet,
    departmentId: params.departmentId,
    workingDays: params.workingDays,
  });
}

/**
 * Org holidays in range that fall on a department working weekday (for metrics, e.g. holiday_days).
 */
export function countQualifyingOrgHolidaysInRange(params: {
  startDate: string;
  endDate: string;
  holidaySet: Set<string>;
  departmentId: string | null | undefined;
  workingDays: string[] | null | undefined;
}): number {
  const { startDate, endDate, holidaySet, departmentId, workingDays } = params;
  let count = 0;
  const startIST = new Date(`${startDate}T00:00:00+05:30`);
  const endIST = new Date(`${endDate}T23:59:59+05:30`);
  let current = new Date(startIST);

  while (current <= endIST) {
    const dateStr = formatDateLocal(current);
    if (
      holidaySet.has(dateStr) &&
      isUserWorkingWeekdayByDepartment(departmentId, workingDays, dateStr)
    ) {
      count++;
    }
    current = new Date(current.getTime() + 24 * 60 * 60 * 1000);
  }

  return count;
}
