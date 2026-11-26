import type { LeaveDaySession } from '../models/LeaveRequest';
import type { ResolvedShiftTimes } from '../services/attendance-shift.service';
import { resolveShift } from '../services/attendance-shift.service';
import { parseTimeToMinutes } from './date.utils';

export type LeaveSessionWindow = {
  session_start_time: string;
  session_end_time: string;
  shift_start_time: string;
  shift_end_time: string;
  break_start_time: string;
  break_end_time: string;
};

type BreakWindowMinutes = {
  breakStartM: number;
  breakEndM: number;
};

const HALF_DAY_SHIFT_REQUIRED_MESSAGE =
  'Half-day leave requires a configured work shift with start and end times';

const isValidTime = (value: string | null | undefined): value is string =>
  Boolean(value && parseTimeToMinutes(value) > 0);

const hasValidShiftConfig = (
  shift: ResolvedShiftTimes | null,
): shift is ResolvedShiftTimes & { start_time: string; end_time: string } => {
  if (!shift) {
    return false;
  }

  const start = shift.start_time;
  const end = shift.end_time;

  if (!isValidTime(start) || !isValidTime(end)) {
    return false;
  }

  return parseTimeToMinutes(start) < parseTimeToMinutes(end);
};

const getValidBreakWindow = (
  shift: ResolvedShiftTimes,
  startM: number,
  endM: number,
): BreakWindowMinutes | null => {
  const breakStart = shift.break_start_time;
  const breakEnd = shift.break_end_time;

  if (!isValidTime(breakStart) || !isValidTime(breakEnd)) {
    return null;
  }

  const breakStartM = parseTimeToMinutes(breakStart);
  const breakEndM = parseTimeToMinutes(breakEnd);

  if (!(startM < breakStartM && breakStartM < breakEndM && breakEndM < endM)) {
    return null;
  }

  return { breakStartM, breakEndM };
};

const formatMinutesToTime = (totalMinutes: number): string => {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;
};

const computeHalfDaySplitMinutes = (
  startM: number,
  endM: number,
  breakWindow: BreakWindowMinutes | null,
): number => {
  if (!breakWindow) {
    return Math.floor((startM + endM) / 2);
  }

  const { breakStartM, breakEndM } = breakWindow;
  const totalWork = endM - startM - (breakEndM - breakStartM);
  let remaining = Math.floor(totalWork / 2);
  let cursor = startM;

  while (remaining > 0) {
    if (cursor < breakStartM) {
      const workAvailable = breakStartM - cursor;
      if (remaining <= workAvailable) {
        return cursor + remaining;
      }
      remaining -= workAvailable;
      cursor = breakEndM;
      continue;
    }

    if (cursor < breakEndM) {
      cursor = breakEndM;
      continue;
    }

    return cursor + remaining;
  }

  return cursor;
};

/**
 * Derive the leave session time window from the employee's resolved shift.
 * FULL: start_time -> end_time
 * FIRST_HALF / SECOND_HALF: split at working-time midpoint when break is valid
 * (equal work minutes from start, skipping break); otherwise clock midpoint (start + end) / 2.
 */
export function resolveLeaveSessionWindow(
  shift: ResolvedShiftTimes | null,
  daySession: LeaveDaySession | string | null | undefined,
): LeaveSessionWindow | null {
  const session = (daySession ?? 'FULL') as LeaveDaySession;

  if (!hasValidShiftConfig(shift)) {
    return null;
  }

  const startM = parseTimeToMinutes(shift.start_time);
  const endM = parseTimeToMinutes(shift.end_time);
  const breakStartTime = shift.break_start_time ?? '';
  const breakEndTime = shift.break_end_time ?? '';

  if (session === 'FULL') {
    return {
      session_start_time: shift.start_time,
      session_end_time: shift.end_time,
      shift_start_time: shift.start_time,
      shift_end_time: shift.end_time,
      break_start_time: breakStartTime,
      break_end_time: breakEndTime,
    };
  }

  const breakWindow = getValidBreakWindow(shift, startM, endM);
  const splitM = computeHalfDaySplitMinutes(startM, endM, breakWindow);

  if (splitM <= startM || splitM >= endM) {
    return null;
  }

  const sessionStartM = session === 'FIRST_HALF' ? startM : splitM;
  const sessionEndM = session === 'FIRST_HALF' ? splitM : endM;

  if (sessionStartM >= sessionEndM) {
    return null;
  }

  return {
    session_start_time: formatMinutesToTime(sessionStartM),
    session_end_time: formatMinutesToTime(sessionEndM),
    shift_start_time: shift.start_time,
    shift_end_time: shift.end_time,
    break_start_time: breakStartTime,
    break_end_time: breakEndTime,
  };
}

export function assertHalfDayShiftConfigured(
  shift: ResolvedShiftTimes | null,
  daySession: LeaveDaySession | string | null | undefined,
): { ok: true; window: LeaveSessionWindow } | { ok: false; message: string } {
  const window = resolveLeaveSessionWindow(shift, daySession);
  if (!window) {
    return { ok: false, message: HALF_DAY_SHIFT_REQUIRED_MESSAGE };
  }

  return { ok: true, window };
}

export async function resolveShiftForUser(
  org_id: string,
  user_id: string,
): Promise<ResolvedShiftTimes | null> {
  return resolveShift(org_id, user_id);
}

export async function resolveLeaveSessionWindowsForUsers(
  org_id: string,
  userIds: string[],
): Promise<Map<string, ResolvedShiftTimes | null>> {
  const uniqueUserIds = Array.from(new Set(userIds.filter(Boolean).map(String)));
  const shiftByUserId = new Map<string, ResolvedShiftTimes | null>();

  await Promise.all(
    uniqueUserIds.map(async (userId) => {
      shiftByUserId.set(userId, await resolveShift(org_id, userId));
    }),
  );

  return shiftByUserId;
}

export function sessionWindowForLeaveRow(
  shift: ResolvedShiftTimes | null | undefined,
  daySession: LeaveDaySession | string | null | undefined,
): LeaveSessionWindow | null {
  return resolveLeaveSessionWindow(shift ?? null, daySession);
}

export async function enrichLeaveRowsWithSessionWindows<
  T extends { user_id?: string | null; day_session?: LeaveDaySession | string | null },
>(org_id: string, rows: T[]): Promise<Map<T, LeaveSessionWindow | null>> {
  const shiftByUserId = await resolveLeaveSessionWindowsForUsers(
    org_id,
    rows.map((row) => String(row.user_id ?? '')),
  );

  const result = new Map<T, LeaveSessionWindow | null>();
  for (const row of rows) {
    const shift = shiftByUserId.get(String(row.user_id ?? '')) ?? null;
    result.set(row, sessionWindowForLeaveRow(shift, row.day_session));
  }

  return result;
}
