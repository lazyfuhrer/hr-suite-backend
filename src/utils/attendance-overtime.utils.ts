import { AttendanceBreak } from '../models/AttendanceBreak';
import { AttendanceLog } from '../models/AttendanceLog';
import { User } from '../models/User';
import { resolveShift } from '../services/attendance-shift.service';
import { fetchPrimaryManagedDepartmentScheduleByManagerIds } from './department-manager.utils';
import {
  fetchEffectiveHolidayDateSet,
  isUserAttendanceScheduledDay,
  normalizeCalendarDate,
  resolveEffectiveAttendanceSchedule,
} from './attendance-schedule.utils';
import { parseTimeToMinutes } from './date.utils';
import { getOrgOtRoundOffSettings } from './ot-round-off.utils';

export const calculateBreakSeconds = (
  breaks: Array<{ start_time: string; end_time?: string | null }>,
  now: Date = new Date(),
): number =>
  breaks.reduce((total, entry) => {
    const start = new Date(entry.start_time);
    const end = entry.end_time ? new Date(entry.end_time) : now;
    const diff = Math.max(0, end.getTime() - start.getTime());
    return total + Math.round(diff / 1000);
  }, 0);

export const calculateWorkSeconds = (
  clockInTime: string | null | undefined,
  clockOutTime: string | null | undefined,
  breaks: Array<{ start_time: string; end_time?: string | null }> = [],
): number => {
  if (!clockInTime) {
    return 0;
  }

  const clockInDate = new Date(clockInTime);
  if (Number.isNaN(clockInDate.getTime())) {
    return 0;
  }

  const endDate = clockOutTime ? new Date(clockOutTime) : new Date();
  if (Number.isNaN(endDate.getTime())) {
    return 0;
  }

  const grossMs = Math.max(0, endDate.getTime() - clockInDate.getTime());
  const breakSeconds = calculateBreakSeconds(breaks, endDate);
  const netMs = Math.max(0, grossMs - breakSeconds * 1000);

  return Math.round(netMs / 1000);
};

/** Scheduled break from work_shifts. When both window and duration_mins are set, uses the smaller (duration caps window). */
export const getScheduledBreakSeconds = (
  shiftBreak:
    | {
        break_start_time?: string | null;
        break_end_time?: string | null;
        break_duration_mins?: number | null;
      }
    | null
    | undefined,
  shiftSpanSeconds: number,
): number => {
  if (!shiftBreak || shiftSpanSeconds <= 0) {
    return 0;
  }

  const startRaw = shiftBreak.break_start_time;
  const endRaw = shiftBreak.break_end_time;
  const startStr =
    startRaw != null && String(startRaw).trim() !== '' ? String(startRaw).trim() : '';
  const endStr = endRaw != null && String(endRaw).trim() !== '' ? String(endRaw).trim() : '';

  let windowBreakSeconds = 0;
  if (startStr && endStr) {
    const startM = parseTimeToMinutes(startStr);
    const endM = parseTimeToMinutes(endStr);
    let breakMinutes = 0;
    if (endM > startM) {
      breakMinutes = endM - startM;
    } else if (endM < startM) {
      breakMinutes = 24 * 60 - startM + endM;
    }
    if (breakMinutes > 0) {
      windowBreakSeconds = breakMinutes * 60;
    }
  }

  const durationMins = shiftBreak.break_duration_mins;
  const durationBreakSeconds =
    durationMins != null && Number(durationMins) > 0 ? Number(durationMins) * 60 : 0;

  let scheduledBreakSeconds = 0;
  if (windowBreakSeconds > 0 && durationBreakSeconds > 0) {
    scheduledBreakSeconds = Math.min(windowBreakSeconds, durationBreakSeconds);
  } else if (windowBreakSeconds > 0) {
    scheduledBreakSeconds = windowBreakSeconds;
  } else if (durationBreakSeconds > 0) {
    scheduledBreakSeconds = durationBreakSeconds;
  }

  return Math.min(scheduledBreakSeconds, shiftSpanSeconds);
};

/** Net work vs expected net shift (span minus scheduled break). Imputes untaken scheduled break for OT only. */
export const calculateOvertimeSeconds = (
  totalWorkSeconds: number,
  shiftStartTime: string | null | undefined,
  shiftEndTime: string | null | undefined,
  shiftBreak?: {
    break_start_time?: string | null;
    break_end_time?: string | null;
    break_duration_mins?: number | null;
  } | null,
  actualBreakSeconds = 0,
): number => {
  if (totalWorkSeconds <= 0 || !shiftStartTime || !shiftEndTime) {
    return 0;
  }

  const shiftStartMinutes = parseTimeToMinutes(shiftStartTime);
  const shiftEndMinutes = parseTimeToMinutes(shiftEndTime);

  if (shiftStartMinutes === 0 && shiftEndMinutes === 0) {
    return 0;
  }

  let shiftDurationSeconds: number;
  if (shiftEndMinutes < shiftStartMinutes) {
    shiftDurationSeconds = (24 * 60 - shiftStartMinutes + shiftEndMinutes) * 60;
  } else {
    shiftDurationSeconds = (shiftEndMinutes - shiftStartMinutes) * 60;
  }

  const scheduledBreakSeconds = getScheduledBreakSeconds(shiftBreak, shiftDurationSeconds);
  const expectedNetWorkSeconds = Math.max(0, shiftDurationSeconds - scheduledBreakSeconds);
  const imputedBreakSeconds = Math.max(0, scheduledBreakSeconds - actualBreakSeconds);
  const workForOvertimeSeconds = Math.max(0, totalWorkSeconds - imputedBreakSeconds);
  return Math.max(0, workForOvertimeSeconds - expectedNetWorkSeconds);
};

export type EffectiveOvertimeOptions = {
  /** When false, all net work counts as OT (non-working day / holiday). Omitted → shift-surplus OT. */
  isAttendanceScheduledDay?: boolean;
  otRoundOffEnabled?: boolean;
  otRoundOffMins?: number;
};

/** Floor OT seconds down to the nearest multiple of `intervalMins` (no-op if disabled/invalid). */
export const floorOvertimeSeconds = (seconds: number, intervalMins: number): number => {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return Math.max(0, Math.floor(seconds || 0));
  }
  if (!Number.isInteger(intervalMins) || intervalMins < 1) {
    return seconds;
  }
  const intervalSeconds = intervalMins * 60;
  return Math.floor(seconds / intervalSeconds) * intervalSeconds;
};

export const getEffectiveOvertimeSeconds = (
  log: {
    overtime_minutes?: number | null;
    clock_in_time?: string | null;
    clock_out_time?: string | null;
  },
  breaks: Array<{ start_time: string; end_time?: string | null }>,
  shiftStartTime: string | null | undefined,
  shiftEndTime: string | null | undefined,
  shiftBreak?: {
    break_start_time?: string | null;
    break_end_time?: string | null;
    break_duration_mins?: number | null;
  } | null,
  options?: EffectiveOvertimeOptions,
): number => {
  let overtimeSeconds: number;

  if (log.overtime_minutes != null) {
    overtimeSeconds = log.overtime_minutes * 60;
  } else {
    const totalWorkSeconds = calculateWorkSeconds(log.clock_in_time, log.clock_out_time, breaks);

    if (options?.isAttendanceScheduledDay === false) {
      overtimeSeconds = totalWorkSeconds;
    } else {
      const endDate = log.clock_out_time ? new Date(log.clock_out_time) : new Date();
      const actualBreakSeconds = calculateBreakSeconds(breaks, endDate);
      overtimeSeconds = calculateOvertimeSeconds(
        totalWorkSeconds,
        shiftStartTime,
        shiftEndTime,
        shiftBreak,
        actualBreakSeconds,
      );
    }
  }

  if (options?.otRoundOffEnabled) {
    return floorOvertimeSeconds(overtimeSeconds, options.otRoundOffMins ?? 0);
  }

  return overtimeSeconds;
};

const isShiftConfigured = (
  shiftStartTime: string | null | undefined,
  shiftEndTime: string | null | undefined,
): boolean => {
  const startM = parseTimeToMinutes(shiftStartTime);
  const endM = parseTimeToMinutes(shiftEndTime);
  return !(startM === 0 && endM === 0);
};

/**
 * Sum overtime hours for a payroll month.
 * Scheduled days: shift-surplus OT. Non-scheduled days (off-weekday / holiday): full net work as OT.
 */
export async function computeMonthlyShiftBasedOvertimeHours(params: {
  orgId: string;
  userId: string;
  monthStart: string;
  monthEnd: string;
}): Promise<number> {
  const { orgId, userId, monthStart, monthEnd } = params;

  const attendanceLogs = await AttendanceLog.query()
    .where('org_id', orgId)
    .where('user_id', userId)
    .whereBetween('date', [monthStart, monthEnd])
    .whereNotNull('clock_in_time')
    .whereNotNull('clock_out_time')
    .select('id', 'date', 'clock_in_time', 'clock_out_time', 'overtime_minutes');

  if (attendanceLogs.length === 0) {
    return 0;
  }

  const [shift, holidaySet, userRow, otRoundOff] = await Promise.all([
    resolveShift(orgId, userId),
    fetchEffectiveHolidayDateSet(orgId, userId, monthStart, monthEnd),
    User.query()
      .alias('u')
      .leftJoin('departments as d', 'd.id', 'u.department_id')
      .where('u.id', userId)
      .where('u.org_id', orgId)
      .select('u.role', 'u.department_id', 'd.working_days as department_working_days')
      .first(),
    getOrgOtRoundOffSettings(orgId),
  ]);

  const userRole = (userRow as { role?: string } | undefined)?.role ?? null;
  let managedScheduleFallback: { departmentId: string; workingDays: string[] | null } | undefined;
  if (userRole === 'manager') {
    const fbMap = await fetchPrimaryManagedDepartmentScheduleByManagerIds(orgId, [userId]);
    managedScheduleFallback = fbMap.get(String(userId));
  }

  const schedule = resolveEffectiveAttendanceSchedule(
    {
      role: userRole,
      department_id:
        (userRow as { department_id?: string | null } | undefined)?.department_id ?? null,
      department_working_days:
        (userRow as { department_working_days?: unknown } | undefined)?.department_working_days ??
        null,
    },
    managedScheduleFallback,
  );

  const shiftConfigured = Boolean(
    shift?.start_time && shift?.end_time && isShiftConfigured(shift.start_time, shift.end_time),
  );
  const shiftStart = shiftConfigured ? shift!.start_time : null;
  const shiftEnd = shiftConfigured ? shift!.end_time : null;
  const shiftBreak = shiftConfigured
    ? {
        break_start_time: shift!.break_start_time ?? null,
        break_end_time: shift!.break_end_time ?? null,
        break_duration_mins: shift!.break_duration_mins ?? null,
      }
    : null;

  const logIds = attendanceLogs.map((log) => log.id);
  const breakRows =
    logIds.length > 0
      ? await AttendanceBreak.query()
          .whereIn('attendance_log_id', logIds)
          .select('attendance_log_id', 'start_time', 'end_time')
      : [];

  const breaksByLogId = new Map<string, Array<{ start_time: string; end_time?: string | null }>>();
  for (const brk of breakRows) {
    const logId = String(brk.attendance_log_id);
    if (!breaksByLogId.has(logId)) {
      breaksByLogId.set(logId, []);
    }
    breaksByLogId.get(logId)!.push({
      start_time: brk.start_time,
      end_time: brk.end_time ?? null,
    });
  }

  let totalOvertimeSeconds = 0;
  for (const log of attendanceLogs) {
    const dateStr = normalizeCalendarDate((log as { date?: string | Date }).date);
    const isScheduled = isUserAttendanceScheduledDay({
      dateStr,
      holidaySet,
      departmentId: schedule.departmentId,
      workingDays: schedule.workingDays,
    });
    const breaks = breaksByLogId.get(String(log.id)) ?? [];
    totalOvertimeSeconds += getEffectiveOvertimeSeconds(
      log,
      breaks,
      shiftStart,
      shiftEnd,
      shiftBreak,
      {
        isAttendanceScheduledDay: isScheduled,
        otRoundOffEnabled: otRoundOff.enabled,
        otRoundOffMins: otRoundOff.mins,
      },
    );
  }

  return Math.round((totalOvertimeSeconds / 3600) * 100) / 100;
}
