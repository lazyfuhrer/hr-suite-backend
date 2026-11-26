import type { Request, Response } from 'express';
import type { PartialModelObject } from 'objection';

import { AttendanceBreak } from '../models/AttendanceBreak';
import { AttendanceCorrectionRequest } from '../models/AttendanceCorrectionRequest';
import { AttendanceLog } from '../models/AttendanceLog';
import { OfficeLocation } from '../models/OfficeLocation';
import { User } from '../models/User';
import { DepartmentManager } from '../models/DepartmentManager';
import { UserAllowedLocation } from '../models/UserAllowedLocation';
import { LeaveRequest, type LeaveDaySession } from '../models/LeaveRequest';
import { WfhRequest } from '../models/WfhRequest';
import { mergeLeaveDaySessions } from '../utils/leave.utils';
import { loadApprovedWfhDatesInRange, userHasApprovedWfhOnDate } from '../utils/wfh.utils';
import {
  ADMIN_ATTENDANCE_STATUS_SORT_ORDER,
  ADMIN_VISIBLE_ATTENDANCE_STATUSES,
  isHalfDayLeaveSession,
  resolveAdminAttendanceStatus,
  resolveCalendarAttendanceStatus,
  type AdminAttendanceStatus,
  type CalendarAttendanceStatus,
} from '../utils/attendance-status.utils';
import {
  resolveLeaveSessionWindow,
  resolveLeaveSessionWindowsForUsers,
  sessionWindowForLeaveRow,
  type LeaveSessionWindow,
} from '../utils/leave-session.utils';
import { EmployeeEmploymentDetail } from '../models/EmployeeEmploymentDetail';
import { Organization } from '../models/Organization';
import { Department } from '../models/Department';
import { ORG_USER_ROLES } from '../constants/user-roles';
import {
  ATTENDANCE_ACTIVE_EMPLOYEE_STATUSES,
  REAL_EMPLOYEE_STATUSES,
} from '../constants/user-status';
import { calculateDistance, isWithinRadius } from '../utils/geo.utils';
import {
  fetchPrimaryManagedDepartmentScheduleByManagerIds,
  getManagedDepartmentIds,
  getManagedDepartmentSummaries,
} from '../utils/department-manager.utils';
import {
  fetchWorkShiftsByDepartmentIds,
  resolveEmployeeWorkShifts,
  type WorkShiftSummary,
} from '../utils/department-shift.utils';
import {
  formatDateLocal,
  getNowInIST,
  getTodayDate,
  normalizeDate,
  formatTime,
  timeStringToISO,
  parseTimeToMinutes,
  IST_OFFSET_MS,
} from '../utils/date.utils';
import {
  DEFAULT_LATE_GRACE_PERIOD_MINS,
  getOrgLateGracePeriodMins,
} from '../utils/late-grace.utils';
import { getOrgOtRoundOffSettings } from '../utils/ot-round-off.utils';
import type { OrgOtRoundOffSettings } from '../utils/ot-round-off.utils';
import {
  countQualifyingOrgHolidaysInRange,
  fetchEffectiveHolidayDateSetsForUsers,
  fetchEffectiveHolidayDatesAndTitles,
  fetchOrgHolidayDateSet,
  isUserAttendanceScheduledDay,
  resolveEffectiveAttendanceSchedule,
  shouldOmitAttendanceCalendarDate,
} from '../utils/attendance-schedule.utils';
import {
  attendanceBreakStartSchema,
  attendanceClockInSchema,
  attendanceClockOutSchema,
  attendanceFaceClockSchema,
  attendanceFaceClockLocationVerifySchema,
  attendanceFaceVerifyAndClockInSchema,
  attendanceCalendarQuerySchema,
  attendanceWeeklySummaryQuerySchema,
  attendanceMonthlyPerformanceQuerySchema,
  attendanceOrgDashboardQuerySchema,
  attendanceOrgEmployeeListQuerySchema,
  attendanceExcelDownloadQuerySchema,
  attendanceAdminCardsSummaryQuerySchema,
  attendanceUserAllowedLocationCreateSchema,
  attendanceUserAllowedLocationUserParamsSchema,
  attendanceUserAllowedLocationDeleteParamsSchema,
  attendanceUserAllowedLocationStatusUpdateSchema,
  attendanceUserClockInLocationsQuerySchema,
} from '../validators';
import { identifyUserByS3Image } from '../services/face-recognition.service';
import { resolveShift } from '../services/attendance-shift.service';
import {
  ACTIVITY_ENTITY_TYPES,
  ACTIVITY_TYPES,
  ActivityLogService,
} from '../services/activity-log.service';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getS3Client } from '../utils/s3';
import { env } from '../config/env';
import {
  calculateBreakSeconds,
  calculateWorkSeconds,
  getEffectiveOvertimeSeconds,
} from '../utils/attendance-overtime.utils';
import {
  attendanceExcelFileName,
  generateMonthlyAttendanceExcelBuffer,
  resolveAttendanceExcelPeriod,
} from '../utils/monthly-attendance-excel.utils';
import {
  AttendanceBulkImportParseError,
  importAttendanceBulkRows,
  parseAndPrepareAttendanceBulkImport,
  validateAttendanceBulkImportRows,
} from '../services/attendance-bulk-import.service';
import {
  attendanceBulkImportTemplateFilename,
  buildAttendanceBulkImportTemplateBuffer,
} from '../utils/attendance-bulk-import-template.utils';
import { attendanceBulkImportQuerySchema } from '../validators/tenant/attendance-bulk-import.validator';

const calculateBreakMinutes = (
  breaks: Array<{ start_time: string; end_time?: string | null }>,
  now: Date = new Date(),
): number => Math.round(calculateBreakSeconds(breaks, now) / 60);

const parseCoordinate = (value: string | null | undefined): number | null => {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeDepartmentLocationIds = (department?: {
  location_id?: string | null;
  location_ids?: string[] | null;
}): string[] => {
  if (!department) {
    return [];
  }

  if (Array.isArray(department.location_ids) && department.location_ids.length > 0) {
    const valid = department.location_ids.filter((id): id is string => typeof id === 'string');
    return Array.from(new Set(valid));
  }

  return department.location_id ? [department.location_id] : [];
};

// Helper function to format ISO timestamp to HH:MM in IST timezone

// Helper function to calculate late arrival in minutes
const calculateLateArrival = (
  clockInTime: string | null | undefined,
  shiftStartTime: string | null | undefined,
  graceMins: number = DEFAULT_LATE_GRACE_PERIOD_MINS,
): { isLate: boolean; lateByMinutes: number } => {
  if (!clockInTime || !shiftStartTime) {
    return { isLate: false, lateByMinutes: 0 };
  }

  try {
    const clockInDate = new Date(clockInTime);
    if (Number.isNaN(clockInDate.getTime())) {
      return { isLate: false, lateByMinutes: 0 };
    }

    // Convert UTC clock-in time to IST for comparison with shift time (which is in IST)
    const istClockInDate = new Date(clockInDate.getTime() + IST_OFFSET_MS);
    const clockInMinutes = istClockInDate.getUTCHours() * 60 + istClockInDate.getUTCMinutes();
    const shiftStartMinutes = parseTimeToMinutes(shiftStartTime);

    if (shiftStartMinutes === 0) {
      return { isLate: false, lateByMinutes: 0 };
    }

    const diff = clockInMinutes - shiftStartMinutes;

    if (diff > graceMins) {
      return { isLate: true, lateByMinutes: diff };
    }

    return { isLate: false, lateByMinutes: 0 };
  } catch {
    return { isLate: false, lateByMinutes: 0 };
  }
};

type ClockOutType = 'self' | 'system' | 'regularized';

const determineClockOutType = (
  clockOutTime: string | null | undefined,
  shiftEndTime: string | null | undefined,
  hasRegularizedClockOut: boolean,
): ClockOutType | null => {
  if (!clockOutTime) {
    return null;
  }

  if (hasRegularizedClockOut) {
    return 'regularized';
  }

  if (!shiftEndTime) {
    return 'self';
  }

  try {
    const clockOutDate = new Date(clockOutTime);
    if (Number.isNaN(clockOutDate.getTime())) {
      return 'self';
    }

    // Convert UTC timestamp to IST local time for comparison with shift end (which is in IST)
    const istClockOut = new Date(clockOutDate.getTime() + IST_OFFSET_MS);
    const clockOutMinutes = istClockOut.getUTCHours() * 60 + istClockOut.getUTCMinutes();
    const clockOutSeconds = istClockOut.getUTCSeconds();

    const shiftEndMinutes = parseTimeToMinutes(shiftEndTime);
    if (shiftEndMinutes === 0) {
      return 'self';
    }

    // Auto clock-out scheduler always sets clock_out_time exactly at shift end (HH:MM:00)
    if (clockOutMinutes === shiftEndMinutes && clockOutSeconds === 0) {
      return 'system';
    }

    return 'self';
  } catch {
    return 'self';
  }
};

// Helper function to fetch and process attendance data for a date range
const fetchAttendanceData = async (
  org_id: string,
  user_id: string,
  startDate: string,
  endDate: string,
): Promise<{
  logs: AttendanceLog[];
  logsByDate: Map<string, AttendanceLog>;
  approvedLeavesByDate: Map<string, LeaveDaySession>;
  approvedWfhDates: Set<string>;
  breaksByLogId: Map<string, Array<{ start_time: string; end_time?: string | null }>>;
  pendingRequestsByDate: Map<string, AttendanceCorrectionRequest>;
  shift: any;
  shiftBreakLimit: number;
  shiftStartTime: string | null;
  shiftEndTime: string | null;
  shiftBreakForOvertime: {
    break_start_time: string | null;
    break_end_time: string | null;
    break_duration_mins: number | null;
  } | null;
}> => {
  // Fetch attendance logs
  const logs = await AttendanceLog.query()
    .where('org_id', org_id)
    .where('user_id', user_id)
    .whereBetween('date', [startDate, endDate])
    .orderBy('date', 'asc');

  // Fetch pending correction requests
  const pendingRequests = await AttendanceCorrectionRequest.query()
    .where('user_id', user_id)
    .where('status', 'PENDING')
    .whereBetween('request_date', [startDate, endDate]);

  const pendingRequestsByDate = new Map<string, AttendanceCorrectionRequest>();
  for (const request of pendingRequests) {
    pendingRequestsByDate.set(request.request_date, request);
  }

  // Fetch approved leaves overlapping the requested range
  const approvedLeaves = await LeaveRequest.query()
    .where('org_id', org_id)
    .where('user_id', user_id)
    .where('status', 'APPROVED')
    .where((qb) => {
      qb.whereBetween('start_date', [startDate, endDate])
        .orWhereBetween('end_date', [startDate, endDate])
        .orWhere((subQb) => {
          subQb.where('start_date', '<=', startDate).where('end_date', '>=', endDate);
        });
    });

  const approvedLeavesByDate = new Map<string, LeaveDaySession>();
  for (const leave of approvedLeaves) {
    const start = new Date(leave.start_date);
    const end = new Date(leave.end_date);
    const cursor = new Date(start);
    while (cursor <= end) {
      const key = formatDateLocal(cursor);
      if (key >= startDate && key <= endDate) {
        approvedLeavesByDate.set(
          key,
          mergeLeaveDaySessions(approvedLeavesByDate.get(key), leave.day_session),
        );
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  const approvedWfhDates = await loadApprovedWfhDatesInRange(org_id, user_id, startDate, endDate);

  // Create a map of dates to logs
  const logsByDate = new Map<string, AttendanceLog>();
  const logIds: string[] = [];
  for (const log of logs) {
    const normalizedDate = normalizeDate(log.date);
    if (normalizedDate) {
      logsByDate.set(normalizedDate, log);
    }
    logIds.push(String((log as any).id));
  }

  // Fetch all breaks
  const allBreaks =
    logIds.length > 0
      ? await AttendanceBreak.query()
          .whereIn('attendance_log_id', logIds)
          .select('attendance_log_id', 'start_time', 'end_time')
      : [];

  const breaksByLogId = new Map<string, Array<{ start_time: string; end_time?: string | null }>>();
  for (const breakEntry of allBreaks) {
    const logId = String((breakEntry as any).attendance_log_id);
    if (!breaksByLogId.has(logId)) {
      breaksByLogId.set(logId, []);
    }
    breaksByLogId.get(logId)!.push({
      start_time: (breakEntry as any).start_time,
      end_time: (breakEntry as any).end_time,
    });
  }

  // Get shift info
  const shift = await resolveShift(org_id, user_id);
  const shiftBreakLimit = shift?.break_duration_mins ?? 0;
  const shiftStartTime = shift?.start_time ?? null;
  const shiftEndTime = shift?.end_time ?? null;
  const shiftBreakForOvertime = shift
    ? {
        break_start_time: shift.break_start_time ?? null,
        break_end_time: shift.break_end_time ?? null,
        break_duration_mins:
          shift.break_duration_mins != null ? Number(shift.break_duration_mins) : null,
      }
    : null;

  return {
    logs,
    logsByDate,
    approvedLeavesByDate,
    approvedWfhDates,
    breaksByLogId,
    pendingRequestsByDate,
    shift,
    shiftBreakLimit,
    shiftStartTime,
    shiftEndTime,
    shiftBreakForOvertime,
  };
};

// Helper function to build calendar entry for a single date
const buildCalendarEntry = (
  dateStr: string,
  log: AttendanceLog | undefined,
  breaks: Array<{ start_time: string; end_time?: string | null }>,
  shiftBreakLimit: number,
  shiftStartTime: string | null,
  shiftEndTime: string | null,
  shiftBreakForOvertime: {
    break_start_time: string | null;
    break_end_time: string | null;
    break_duration_mins: number | null;
  } | null,
  lateGracePeriodMins: number,
  isAttendanceScheduledDay: boolean,
  otRoundOff: OrgOtRoundOffSettings = { enabled: false, mins: 15 },
): {
  date: string;
  status: 'PRESENT' | 'LATE' | 'ABSENT';
  clock_in_time?: string | null;
  clock_out_time?: string | null;
  total_work_seconds?: number | null;
  total_break_seconds?: number;
  is_excess_break?: boolean;
  is_late_arrival?: boolean;
  late_by_minutes?: number;
  overtime_seconds?: number;
  effective_seconds?: number;
  shift_start_time?: string | null;
  shift_end_time?: string | null;
} => {
  if (!log) {
    return {
      date: dateStr,
      status: 'ABSENT',
    };
  }

  // Calculate work seconds from timestamps (exact calculation)
  const totalWorkSeconds = calculateWorkSeconds(log.clock_in_time, log.clock_out_time, breaks);
  const totalBreakSeconds = calculateBreakSeconds(
    breaks,
    log.clock_out_time ? new Date(log.clock_out_time) : new Date(),
  );
  const isExcessBreak = shiftBreakLimit > 0 && totalBreakSeconds > shiftBreakLimit * 60;
  const lateInfo = calculateLateArrival(log.clock_in_time, shiftStartTime, lateGracePeriodMins);
  const overtimeSeconds = getEffectiveOvertimeSeconds(
    log,
    breaks,
    shiftStartTime,
    shiftEndTime,
    shiftBreakForOvertime,
    {
      isAttendanceScheduledDay,
      otRoundOffEnabled: otRoundOff.enabled,
      otRoundOffMins: otRoundOff.mins,
    },
  );

  const baseEntry = {
    date: dateStr,
    clock_in_time: log.clock_in_time || null,
    clock_out_time: log.clock_out_time || null,
    total_work_seconds: totalWorkSeconds > 0 ? totalWorkSeconds : null,
    total_break_seconds: totalBreakSeconds,
    is_excess_break: isExcessBreak,
    is_late_arrival: lateInfo.isLate,
    late_by_minutes: lateInfo.lateByMinutes,
    overtime_seconds: overtimeSeconds,
    effective_seconds: totalWorkSeconds,
    shift_start_time: timeStringToISO(dateStr, shiftStartTime),
    shift_end_time: timeStringToISO(dateStr, shiftEndTime),
  };

  // Status reflects arrival time only; excess break is indicated via is_excess_break.
  return {
    ...baseEntry,
    status: lateInfo.isLate ? 'LATE' : 'PRESENT',
  };
};

type CalendarEntryRow = {
  date: string;
  status: CalendarAttendanceStatus;
  clock_in_time?: string | null;
  clock_out_time?: string | null;
  total_work_hours?: number | null;
  total_work_minutes?: number | null;
  total_break_time?: number;
  is_excess_break?: boolean;
  is_late_arrival?: boolean;
  late_by_minutes?: number;
  overtime_hours?: number;
  overtime_minutes?: number;
  effective_hours?: number;
  effective_minutes?: number;
  shift_start_time?: string | null;
  shift_end_time?: string | null;
  total_work_seconds?: number | null;
  total_break_seconds?: number | null;
  overtime_seconds?: number;
  effective_seconds?: number;
  /** Org holiday name when status is HOLIDAY (no log on that date). */
  holiday_title?: string | null;
  /** Approved leave session covering this date, when the employee is on leave. */
  leave_session?: LeaveDaySession | null;
  session_window?: LeaveSessionWindow | null;
  /** True when the date is covered by an approved WFH request and the employee punched. */
  is_wfh?: boolean;
};

// Helper function to build calendar entries for a date range (reusable by Calendar, Weekly Summary, Monthly Performance)
const buildCalendarEntries = async (
  org_id: string,
  user_id: string,
  startDate: string,
  endDate: string,
): Promise<{ entries: CalendarEntryRow[]; holidayDays: number }> => {
  // Fetch and process attendance data
  const {
    logsByDate,
    approvedLeavesByDate,
    approvedWfhDates,
    breaksByLogId,
    pendingRequestsByDate,
    shiftBreakLimit,
    shiftStartTime,
    shiftEndTime,
    shiftBreakForOvertime,
    shift,
  } = await fetchAttendanceData(org_id, user_id, startDate, endDate);

  const lateGracePeriodMins = await getOrgLateGracePeriodMins(org_id);
  const otRoundOff = await getOrgOtRoundOffSettings(org_id);

  const [userRow, holidayRange] = await Promise.all([
    User.query()
      .alias('u')
      .leftJoin('departments as d', 'd.id', 'u.department_id')
      .where('u.id', user_id)
      .where('u.org_id', org_id)
      .select(
        'u.date_of_joining',
        'u.role',
        'u.department_id',
        'd.working_days as department_working_days',
      )
      .first(),
    fetchEffectiveHolidayDatesAndTitles(org_id, user_id, startDate, endDate),
  ]);

  const holidaySet = holidayRange.dates;
  const holidayTitleByDate = holidayRange.titleByDate;

  const deptWorkingDaysRaw = (userRow as { department_working_days?: string[] | null } | undefined)
    ?.department_working_days;
  const deptWorkingDaysRawArray = Array.isArray(deptWorkingDaysRaw) ? deptWorkingDaysRaw : null;
  const userRole = (userRow as { role?: string } | undefined)?.role ?? null;
  let managedScheduleFallback = undefined as
    | { departmentId: string; workingDays: string[] | null }
    | undefined;
  if (userRole === 'manager') {
    const fbMap = await fetchPrimaryManagedDepartmentScheduleByManagerIds(org_id, [user_id]);
    managedScheduleFallback = fbMap.get(String(user_id));
  }
  const resolvedSchedule = resolveEffectiveAttendanceSchedule(
    {
      role: userRole,
      department_id: userRow?.department_id ?? null,
      department_working_days: deptWorkingDaysRawArray,
    },
    managedScheduleFallback,
  );
  const departmentId = resolvedSchedule.departmentId;
  const deptWorkingDays = resolvedSchedule.workingDays;

  // Fetch user join date so we can treat pre-joining days specially.
  // IMPORTANT: Treat the stored date-of-joining as a plain date, avoiding UTC
  // conversions that can shift the day across timezones.
  let joinDateStr: string | null = null;
  if (userRow && userRow.date_of_joining) {
    const raw = userRow.date_of_joining as any;

    // Defensive handling for date_of_joining to extract YYYY-MM-DD
    if (raw instanceof Date) {
      joinDateStr = formatDateLocal(raw);
    } else {
      joinDateStr = String(raw).slice(0, 10);
    }
  }

  // Generate all dates in the range
  const calendarEntries: CalendarEntryRow[] = [];

  // Iterate through date strings (YYYY-MM-DD format) - these are already in IST
  // Create Date objects representing IST dates (interpret input dates as IST)
  const startIST = new Date(`${startDate}T00:00:00+05:30`);
  const endIST = new Date(`${endDate}T23:59:59+05:30`);
  const today = getTodayDate();
  let current = new Date(startIST);

  while (current <= endIST) {
    // Format current IST date as YYYY-MM-DD
    // Current is in UTC (from IST conversion), formatDateLocal converts back to IST for display
    const dateStr = formatDateLocal(current);

    // Skip dates before date_of_joining to avoid placeholder statuses.
    if (joinDateStr && dateStr < joinDateStr) {
      current.setTime(current.getTime() + 24 * 60 * 60 * 1000);
      continue;
    }

    const logEarly = logsByDate.get(dateStr);
    const pendingEarly = pendingRequestsByDate.get(dateStr);
    const isHoliday = holidaySet.has(dateStr);
    const hasLog = Boolean(logEarly);
    const hasPendingCorrection = Boolean(pendingEarly);

    // Ensure org holidays appear in the calendar unless there is something more specific to show.
    // Precedence:
    // - approved leave is handled below as LEAVE
    // - attendance logs still render PRESENT/LATE/etc.
    if (isHoliday && !hasLog && !hasPendingCorrection) {
      calendarEntries.push({
        date: dateStr,
        status: 'HOLIDAY',
        holiday_title: holidayTitleByDate.get(dateStr) ?? null,
      });
      current = new Date(current.getTime() + 24 * 60 * 60 * 1000);
      continue;
    }
    if (
      shouldOmitAttendanceCalendarDate({
        dateStr,
        holidaySet,
        departmentId,
        workingDays: deptWorkingDays,
        hasLog,
        hasPendingCorrection,
      })
    ) {
      current = new Date(current.getTime() + 24 * 60 * 60 * 1000);
      continue;
    }

    const leaveSession = approvedLeavesByDate.get(dateStr) ?? null;
    const isOnLeave = leaveSession !== null;
    const isApprovedWfh = approvedWfhDates.has(dateStr);
    const sessionWindow = leaveSession ? resolveLeaveSessionWindow(shift, leaveSession) : null;
    const isFutureDate = dateStr > today;

    // For future dates, only include entries where user is on approved leave or WFH.
    if (isFutureDate && !isOnLeave && !isApprovedWfh) {
      current.setTime(current.getTime() + 24 * 60 * 60 * 1000);
      continue;
    }

    const leaveDerivedStatus = resolveCalendarAttendanceStatus({
      leaveSession,
      hasClockIn: Boolean(logEarly?.clock_in_time),
      evaluationDateStr: dateStr,
      todayStr: today,
    });
    if (leaveDerivedStatus === 'LEAVE' || leaveDerivedStatus === 'HALF_DAY') {
      calendarEntries.push({
        date: dateStr,
        status: leaveDerivedStatus,
        leave_session: leaveSession,
        session_window: sessionWindow,
      });
      current.setTime(current.getTime() + 24 * 60 * 60 * 1000);
      continue;
    }

    const log = logEarly;
    const breaks = log ? (breaksByLogId.get(String((log as any).id)) ?? []) : [];
    const isAttendanceScheduledDay = isUserAttendanceScheduledDay({
      dateStr,
      holidaySet,
      departmentId,
      workingDays: deptWorkingDays,
    });

    const entry = buildCalendarEntry(
      dateStr,
      log,
      breaks,
      shiftBreakLimit,
      shiftStartTime,
      shiftEndTime,
      shiftBreakForOvertime,
      lateGracePeriodMins,
      isAttendanceScheduledDay,
      otRoundOff,
    );

    // On approved WFH with a punch: on-time → WFH, late → LATE; always expose is_wfh.
    // Approved WFH with no punch remains ABSENT (employee was expected to work).
    const hasPunch = Boolean(log?.clock_in_time);
    let status = entry.status as CalendarAttendanceStatus;
    if (isApprovedWfh && hasPunch) {
      status = entry.status === 'LATE' ? 'LATE' : 'WFH';
    }

    calendarEntries.push({
      ...entry,
      status,
      leave_session: leaveSession,
      session_window: sessionWindow,
      is_wfh: isApprovedWfh && hasPunch,
    });

    // Move to next day (add 24 hours)
    current = new Date(current.getTime() + 24 * 60 * 60 * 1000);
  }

  const holidayDays = countQualifyingOrgHolidaysInRange({
    startDate,
    endDate,
    holidaySet,
    departmentId,
    workingDays: deptWorkingDays,
  });

  return { entries: calendarEntries, holidayDays };
};

export class AttendanceController {
  private static async buildFaceClockUserPayload(
    org_id: string,
    user_id: string,
    options?: { location_name?: string | null },
  ) {
    const userRow = await User.query()
      .alias('u')
      .leftJoin('employee_employment_details as eed', 'eed.user_id', 'u.id')
      .select(
        'u.id',
        'u.first_name',
        'u.last_name',
        'u.role',
        'u.designation',
        'u.employee_id',
        'u.department_id',
        'eed.notes as shift_type',
      )
      .where('u.org_id', org_id)
      .where('u.id', user_id)
      .first();

    if (!userRow) {
      return {
        id: user_id,
        full_name: '',
        role: null,
        designation: null,
        employee_id: null,
        department_name: [] as Array<{ id: string; name: string }>,
        shift_type: null,
        location_name: options?.location_name ?? null,
      };
    }

    const row = userRow as any;
    const fullName = `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim();
    const directDepartmentId = row.department_id ? String(row.department_id) : null;
    const managedDepartments =
      row.role === 'manager'
        ? await DepartmentManager.query()
            .where('department_managers.manager_id', row.id)
            .select('department_id')
            .orderBy('created_at', 'asc')
        : [];

    const departmentIds = [
      ...(directDepartmentId ? [directDepartmentId] : []),
      ...(managedDepartments as any[]).map((d) => String(d.department_id)).filter(Boolean),
    ];
    const uniqueDepartmentIds = Array.from(new Set(departmentIds));

    const departments =
      uniqueDepartmentIds.length > 0
        ? await Department.query()
            .where('org_id', org_id)
            .whereIn('id', uniqueDepartmentIds)
            .whereNull('deleted_at')
            .select('id', 'name', 'location_id', 'location_ids')
        : [];

    const department_name = (departments as any[])
      .map((d) => ({ id: String(d.id), name: String(d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const deptLocationIds = Array.from(
      new Set((departments as any[]).flatMap((d) => normalizeDepartmentLocationIds(d))),
    );

    const deptOffice =
      deptLocationIds.length > 0
        ? await OfficeLocation.query()
            .where('org_id', org_id)
            .whereIn('id', deptLocationIds)
            .select('name')
            .orderBy('name', 'asc')
            .first()
        : null;

    const location_name = deptOffice?.name ?? null;

    return {
      id: String(row.id),
      full_name: fullName,
      role: row.role ?? null,
      designation: row.designation ?? null,
      employee_id: row.employee_id ?? null,
      department_name,
      shift_type: row.shift_type ?? null,
      location_name,
    };
  }

  private static async isFaceClockEnabledForOrg(org_id: string): Promise<boolean> {
    const organization = await Organization.query()
      .select('id', 'face_clock_enabled')
      .where('id', org_id)
      .first();

    // Backward-compatible default: enabled unless explicitly false.
    if (!organization) {
      return true;
    }

    return (organization as any).face_clock_enabled !== false;
  }

  private static async getEffectiveAllowedClockInLocations(org_id: string, user_id: string) {
    const user = await User.query()
      .select('id', 'org_id', 'role', 'department_id')
      .where('users.id', user_id)
      .where('users.org_id', org_id)
      .first();

    if (!user) {
      return null;
    }

    const today = getTodayDate();
    const isApprovedWfhToday = await userHasApprovedWfhOnDate(org_id, user_id, today);

    // Determine if geofencing should be applied based on employment work mode.
    // HYBRID and REMOTE employees can clock in from anywhere; only ONSITE requires location check.
    // Approved WFH day: always enforce geofence (overrides HYBRID/REMOTE skip) against
    // department office locations OR active user_allowed_locations.
    const employment = await EmployeeEmploymentDetail.query().findOne({ user_id });
    const workMode = employment?.work_mode;
    const requireGeofence =
      isApprovedWfhToday || workMode === 'ONSITE' || workMode === undefined || workMode === null;

    if (!requireGeofence) {
      return {
        user,
        requireGeofence,
        isApprovedWfhToday: false,
        allowedLocations: [] as Array<any>,
      };
    }

    const departmentIds: string[] = [];
    if (user.department_id) {
      departmentIds.push(String(user.department_id));
    }
    if (user.role === 'manager') {
      const managed = await DepartmentManager.query()
        .where('department_managers.manager_id', user.id)
        .select('department_id')
        .orderBy('created_at', 'asc');
      for (const row of managed as any[]) {
        if (row.department_id) departmentIds.push(String(row.department_id));
      }
    }
    const uniqueDepartmentIds = Array.from(new Set(departmentIds));
    const departments =
      uniqueDepartmentIds.length > 0
        ? await Department.query()
            .where('org_id', org_id)
            .whereIn('id', uniqueDepartmentIds)
            .select('id', 'location_id', 'location_ids')
        : [];
    const departmentLocationIds = Array.from(
      new Set((departments as any[]).flatMap((d) => normalizeDepartmentLocationIds(d))),
    );

    const [departmentLocations, userAllowedLocations] = await Promise.all([
      departmentLocationIds.length > 0
        ? OfficeLocation.query()
            .where('org_id', org_id)
            .whereIn('id', departmentLocationIds)
            .select('id', 'name', 'latitude', 'longitude', 'radius_meters')
        : [],
      UserAllowedLocation.query()
        .where('org_id', org_id)
        .where('user_id', user_id)
        .where('is_active', true)
        .select('id', 'label', 'latitude', 'longitude', 'radius_meters'),
    ]);

    const allowedLocations: Array<{
      id: string;
      source: 'department' | 'designated';
      location_name: string | null;
      latitude: number;
      longitude: number;
      radius_meters: number;
    }> = [];

    for (const location of departmentLocations as any[]) {
      const officeLat = Number(location.latitude);
      const officeLon = Number(location.longitude);
      const radius = Number(location.radius_meters ?? 0);
      if (!Number.isFinite(officeLat) || !Number.isFinite(officeLon) || radius <= 0) {
        continue;
      }
      allowedLocations.push({
        id: String(location.id),
        source: 'department',
        location_name: location.name ?? null,
        latitude: officeLat,
        longitude: officeLon,
        radius_meters: radius,
      });
    }

    for (const location of userAllowedLocations as any[]) {
      const officeLat = Number(location.latitude);
      const officeLon = Number(location.longitude);
      const radius = Number(location.radius_meters ?? 0);
      if (!Number.isFinite(officeLat) || !Number.isFinite(officeLon) || radius <= 0) {
        continue;
      }
      allowedLocations.push({
        id: String(location.id),
        source: 'designated',
        location_name: location.label ?? null,
        latitude: officeLat,
        longitude: officeLon,
        radius_meters: radius,
      });
    }

    return { user, requireGeofence, isApprovedWfhToday, allowedLocations };
  }

  private static async validateClockInLocation(
    org_id: string,
    user_id: string,
    latitude: number,
    longitude: number,
  ): Promise<
    | {
        valid: true;
        meta: { require_geofence: boolean; location_name: string | null; is_wfh?: boolean };
      }
    | { valid: false; status: number; body: any }
  > {
    const context = await AttendanceController.getEffectiveAllowedClockInLocations(org_id, user_id);
    if (!context?.user) {
      return { valid: false, status: 404, body: { message: 'User not found' } };
    }

    if (!context.requireGeofence) {
      return {
        valid: true,
        meta: {
          require_geofence: false,
          location_name: null,
          is_wfh: Boolean((context as any).isApprovedWfhToday),
        },
      };
    }

    const { allowedLocations } = context;
    const isWfh = Boolean((context as any).isApprovedWfhToday);
    if (allowedLocations.length === 0) {
      return {
        valid: false,
        status: 400,
        body: {
          message: isWfh
            ? 'No eligible clock-in locations are configured for your WFH day (office or user profile)'
            : 'No eligible clock-in locations are configured for your department or user profile',
        },
      };
    }

    const matchedLocation = allowedLocations.find((location) =>
      isWithinRadius(
        latitude,
        longitude,
        location.latitude,
        location.longitude,
        location.radius_meters,
      ),
    );

    if (!matchedLocation) {
      const distance = Math.min(
        ...allowedLocations.map((location) =>
          calculateDistance(latitude, longitude, location.latitude, location.longitude),
        ),
      );
      return {
        valid: false,
        status: 403,
        body: {
          message: isWfh
            ? 'You are out of the designated clock-in locations for your WFH day'
            : 'You are out of the designated clock-in locations',
          distance_meters: Math.round(distance),
        },
      };
    }

    return {
      valid: true,
      meta: {
        require_geofence: true,
        location_name: matchedLocation.location_name ?? null,
        is_wfh: isWfh,
      },
    };
  }

  private static async resolveManagedUser(
    org_id: string,
    actorUserId: string,
    actorRole: string,
    targetUserId: string,
  ): Promise<{ user: User | null; isForbidden: boolean }> {
    const targetUser = await User.query().where('org_id', org_id).where('id', targetUserId).first();
    if (!targetUser) {
      return { user: null, isForbidden: false };
    }

    if (actorRole !== 'manager') {
      return { user: targetUser, isForbidden: false };
    }

    const managedDepartmentIds = await getManagedDepartmentIds(org_id, actorUserId);
    const canManage =
      targetUser.role === 'employee' &&
      !!targetUser.department_id &&
      managedDepartmentIds.includes(targetUser.department_id);

    if (!canManage) {
      return { user: null, isForbidden: true };
    }

    return { user: targetUser, isForbidden: false };
  }

  static async addUserAllowedLocation(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsedParams = attendanceUserAllowedLocationUserParamsSchema.safeParse(req.params);
    if (!parsedParams.success) {
      return res.status(400).json({
        message: 'Invalid route params',
        errors: parsedParams.error.flatten().fieldErrors,
      });
    }

    const parsedBody = attendanceUserAllowedLocationCreateSchema.safeParse(req.body);
    if (!parsedBody.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsedBody.error.flatten().fieldErrors,
      });
    }

    const org_id = req.user.org_id;
    const { userId } = parsedParams.data;
    const { user, isForbidden } = await AttendanceController.resolveManagedUser(
      org_id,
      req.user.id,
      req.user.role,
      userId,
    );

    if (isForbidden) {
      return res.status(403).json({ message: 'You are not allowed to manage this user' });
    }
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const payload: PartialModelObject<UserAllowedLocation> = {
      org_id,
      user_id: user.id,
      latitude: String(parsedBody.data.latitude),
      longitude: String(parsedBody.data.longitude),
      radius_meters: parsedBody.data.radius_meters,
      label: parsedBody.data.label?.trim() || null,
      is_active: true,
    };

    try {
      const created = await UserAllowedLocation.query().insert(payload);
      return res.status(201).json({
        message: 'User allowed location added',
        data: {
          id: created.id,
          user_id: created.user_id,
          latitude: Number(created.latitude),
          longitude: Number(created.longitude),
          radius_meters: created.radius_meters,
          label: created.label ?? null,
          is_active: (created as any).is_active ?? true,
        },
      });
    } catch (error: any) {
      const pgCode = error?.nativeError?.code ?? error?.code;
      const constraint = error?.constraint ?? error?.nativeError?.constraint;
      if (pgCode === '23505' && constraint === 'uq_user_allowed_locations_org_user_coords') {
        return res
          .status(409)
          .json({ message: 'This location is already designated for the user' });
      }
      throw error;
    }
  }

  static async listUserAllowedLocations(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsedParams = attendanceUserAllowedLocationUserParamsSchema.safeParse(req.params);
    if (!parsedParams.success) {
      return res.status(400).json({
        message: 'Invalid route params',
        errors: parsedParams.error.flatten().fieldErrors,
      });
    }

    const org_id = req.user.org_id;
    const { userId } = parsedParams.data;
    const { user, isForbidden } = await AttendanceController.resolveManagedUser(
      org_id,
      req.user.id,
      req.user.role,
      userId,
    );

    if (isForbidden) {
      return res.status(403).json({ message: 'You are not allowed to manage this user' });
    }
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const rows = await UserAllowedLocation.query()
      .where('org_id', org_id)
      .where('user_id', user.id)
      .select('id', 'latitude', 'longitude', 'radius_meters', 'label', 'is_active', 'created_at')
      .orderBy('created_at', 'desc');

    return res.json({
      user_id: user.id,
      data: rows.map((row) => ({
        id: row.id,
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        radius_meters: row.radius_meters,
        label: row.label ?? null,
        is_active: (row as any).is_active ?? true,
        created_at: row.created_at,
      })),
    });
  }

  static async listUserClockInLocations(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsedParams = attendanceUserAllowedLocationUserParamsSchema.safeParse(req.params);
    if (!parsedParams.success) {
      return res.status(400).json({
        message: 'Invalid route params',
        errors: parsedParams.error.flatten().fieldErrors,
      });
    }
    const parsedQuery = attendanceUserClockInLocationsQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsedQuery.error.flatten().fieldErrors,
      });
    }

    const org_id = req.user.org_id;
    const { userId } = parsedParams.data;
    const { page, limit } = parsedQuery.data;
    const { user, isForbidden } = await AttendanceController.resolveManagedUser(
      org_id,
      req.user.id,
      req.user.role,
      userId,
    );

    if (isForbidden) {
      return res.status(403).json({ message: 'You are not allowed to manage this user' });
    }
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const userRow = await User.query()
      .select('id', 'org_id', 'role', 'department_id')
      .where('org_id', org_id)
      .where('id', user.id)
      .first();

    if (!userRow) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Department locations:
    // - employees/HR: from their direct department
    // - managers: from all departments they manage (department_managers), plus direct department_id if present
    const departmentIds: string[] = [];
    if (userRow.department_id) {
      departmentIds.push(String(userRow.department_id));
    }
    if (userRow.role === 'manager') {
      const managed = await DepartmentManager.query()
        .where('department_managers.manager_id', userRow.id)
        .select('department_id')
        .orderBy('created_at', 'asc');
      for (const row of managed as any[]) {
        if (row.department_id) departmentIds.push(String(row.department_id));
      }
    }

    const uniqueDepartmentIds = Array.from(new Set(departmentIds));
    const departments =
      uniqueDepartmentIds.length > 0
        ? await Department.query()
            .where('org_id', org_id)
            .whereIn('id', uniqueDepartmentIds)
            .select('id', 'location_id', 'location_ids')
        : [];

    const departmentLocationIds = Array.from(
      new Set((departments as any[]).flatMap((d) => normalizeDepartmentLocationIds(d))),
    );

    const [departmentLocations, userAllowedLocations] = await Promise.all([
      departmentLocationIds.length > 0
        ? OfficeLocation.query()
            .where('org_id', org_id)
            .whereIn('id', departmentLocationIds)
            .select('id', 'name', 'latitude', 'longitude', 'radius_meters')
        : [],
      UserAllowedLocation.query()
        .where('org_id', org_id)
        .where('user_id', user.id)
        .select('id', 'label', 'latitude', 'longitude', 'radius_meters', 'is_active')
        .orderBy('created_at', 'desc'),
    ]);

    const data: Array<{
      id: string;
      location_name: string | null;
      latitude: number;
      longitude: number;
      radius_meters: number;
      location_type: 'department' | 'user';
      is_active?: boolean;
    }> = [];

    for (const location of departmentLocations as any[]) {
      const lat = Number(location.latitude);
      const lon = Number(location.longitude);
      const radius = Number(location.radius_meters ?? 0);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || radius <= 0) {
        continue;
      }
      data.push({
        id: String(location.id),
        location_name: location.name ?? null,
        latitude: lat,
        longitude: lon,
        radius_meters: radius,
        location_type: 'department',
      });
    }

    for (const location of userAllowedLocations as any[]) {
      const lat = Number(location.latitude);
      const lon = Number(location.longitude);
      const radius = Number(location.radius_meters ?? 0);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || radius <= 0) {
        continue;
      }
      data.push({
        id: String(location.id),
        location_name: location.label ?? null,
        latitude: lat,
        longitude: lon,
        radius_meters: radius,
        location_type: 'user',
        is_active: Boolean((location as any).is_active),
      });
    }

    const today = getTodayDate();
    const isApprovedWfhToday = await userHasApprovedWfhOnDate(org_id, user.id, today);
    // On an approved WFH day, clock-in uses office + active designated locations (same union as ONSITE).
    // List returns the full set; inactive designated rows remain visible but are ignored at clock-in.
    const effectiveData = isApprovedWfhToday
      ? data.filter((loc) => loc.location_type === 'department' || loc.is_active !== false)
      : data;

    const total = effectiveData.length;
    const total_pages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(Math.max(page, 1), total_pages);
    const offset = (safePage - 1) * limit;
    const pagedData = effectiveData.slice(offset, offset + limit);

    return res.json({
      user_id: user.id,
      page: safePage,
      limit,
      total,
      total_pages,
      is_wfh_day: isApprovedWfhToday,
      data: pagedData,
    });
  }

  static async deleteUserAllowedLocation(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsedParams = attendanceUserAllowedLocationDeleteParamsSchema.safeParse(req.params);
    if (!parsedParams.success) {
      return res.status(400).json({
        message: 'Invalid route params',
        errors: parsedParams.error.flatten().fieldErrors,
      });
    }

    const org_id = req.user.org_id;
    const { userId, locationId } = parsedParams.data;
    const { user, isForbidden } = await AttendanceController.resolveManagedUser(
      org_id,
      req.user.id,
      req.user.role,
      userId,
    );

    if (isForbidden) {
      return res.status(403).json({ message: 'You are not allowed to manage this user' });
    }
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const deletedCount = await UserAllowedLocation.query()
      .delete()
      .where('id', locationId)
      .where('org_id', org_id)
      .where('user_id', user.id);

    if (deletedCount === 0) {
      return res.status(404).json({ message: 'Allowed location not found' });
    }

    return res.json({ message: 'User allowed location removed' });
  }

  static async updateUserAllowedLocationStatus(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsedParams = attendanceUserAllowedLocationDeleteParamsSchema.safeParse(req.params);
    if (!parsedParams.success) {
      return res.status(400).json({
        message: 'Invalid route params',
        errors: parsedParams.error.flatten().fieldErrors,
      });
    }

    const parsedBody = attendanceUserAllowedLocationStatusUpdateSchema.safeParse(req.body);
    if (!parsedBody.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsedBody.error.flatten().fieldErrors,
      });
    }

    const org_id = req.user.org_id;
    const { userId, locationId } = parsedParams.data;
    const { user, isForbidden } = await AttendanceController.resolveManagedUser(
      org_id,
      req.user.id,
      req.user.role,
      userId,
    );

    if (isForbidden) {
      return res.status(403).json({ message: 'You are not allowed to manage this user' });
    }
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const updated = await UserAllowedLocation.query()
      .patchAndFetchById(locationId, { is_active: parsedBody.data.is_active })
      .where('org_id', org_id)
      .where('user_id', user.id);

    if (!updated) {
      return res.status(404).json({ message: 'Allowed location not found' });
    }

    return res.json({
      message: 'User allowed location updated',
      data: {
        id: updated.id,
        user_id: updated.user_id,
        latitude: Number(updated.latitude),
        longitude: Number(updated.longitude),
        radius_meters: updated.radius_meters,
        label: updated.label ?? null,
        is_active: (updated as any).is_active ?? true,
      },
    });
  }

  static async clockIn(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = attendanceClockInSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { latitude, longitude } = parsed.data;
    const org_id = req.user.org_id;
    const user_id = req.user.id;
    const today = getTodayDate();

    const existing = await AttendanceLog.query().findOne({ org_id, user_id, date: today });
    if (existing) {
      return res.status(400).json({ message: 'Already clocked in for today' });
    }

    const locationValidation = await AttendanceController.validateClockInLocation(
      org_id,
      user_id,
      latitude,
      longitude,
    );
    if (!locationValidation.valid) {
      return res.status(locationValidation.status).json(locationValidation.body);
    }

    const insertPayload: PartialModelObject<AttendanceLog> = {
      org_id,
      user_id,
      date: today,
      clock_in_time: new Date().toISOString(),
      status: 'PRESENT',
      // DECIMAL columns come back as strings in pg/knex; keep the model+insert consistent.
      punch_in_lat: String(latitude),
      punch_in_long: String(longitude),
    };

    const created = await AttendanceLog.query().insert(insertPayload);

    await ActivityLogService.recordActivitySafely({
      org_id,
      actor_user_id: user_id,
      target_user_id: user_id,
      entity_type: ACTIVITY_ENTITY_TYPES.ATTENDANCE_LOG,
      entity_id: created.id,
      activity_type: ACTIVITY_TYPES.CLOCKED_IN,
      metadata: {
        date: today,
        source: 'CLOCK_IN',
      },
    });

    return res.status(201).json({
      message: 'Clocked in successfully',
      attendance_log_id: created.id,
    });
  }

  static async faceClockLocationVerify(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = attendanceFaceClockLocationVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { latitude, longitude } = parsed.data;
    const org_id = req.user.org_id;
    const user_id = req.user.id;
    const faceClockEnabled = await AttendanceController.isFaceClockEnabledForOrg(org_id);

    const locationValidation = await AttendanceController.validateClockInLocation(
      org_id,
      user_id,
      latitude,
      longitude,
    );
    if (!locationValidation.valid) {
      return res.status(locationValidation.status).json(locationValidation.body);
    }

    const user = await AttendanceController.buildFaceClockUserPayload(org_id, user_id);

    if (!faceClockEnabled) {
      const today = getTodayDate();
      const existing = await AttendanceLog.query().findOne({ org_id, user_id, date: today });

      if (!existing) {
        const created = await AttendanceLog.query().insert({
          org_id,
          user_id,
          date: today,
          clock_in_time: new Date().toISOString(),
          status: 'PRESENT',
          // Coordinates are already validated above; store them so admin list shows them.
          punch_in_lat: String(latitude),
          punch_in_long: String(longitude),
        });
        await ActivityLogService.recordActivitySafely({
          org_id,
          actor_user_id: user_id,
          target_user_id: user_id,
          entity_type: ACTIVITY_ENTITY_TYPES.ATTENDANCE_LOG,
          entity_id: created.id,
          activity_type: ACTIVITY_TYPES.CLOCKED_IN,
          metadata: {
            date: today,
            source: 'FACE_CLOCK_LOCATION_VERIFY_FALLBACK',
          },
        });
        return res.json({
          message: 'Location verified successfully',
          location_verified: true,
          require_geofence: locationValidation.meta.require_geofence,
          face_clock_enabled: faceClockEnabled,
          mode: 'CLOCK_IN',
          attendance_log_id: created.id,
          user,
        });
      }
    }

    return res.json({
      message: 'Location verified successfully',
      location_verified: true,
      require_geofence: locationValidation.meta.require_geofence,
      face_clock_enabled: faceClockEnabled,
      user,
    });
  }

  static async faceVerifyAndClockIn(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = attendanceFaceVerifyAndClockInSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { threshold, latitude, longitude } = parsed.data;
    const org_id = req.user.org_id;
    const user_id = req.user.id;
    const faceClockEnabled = await AttendanceController.isFaceClockEnabledForOrg(org_id);
    if (!faceClockEnabled) {
      return res.status(403).json({ message: 'Face clock is disabled for this organization' });
    }
    const today = getTodayDate();
    const existing = await AttendanceLog.query().findOne({ org_id, user_id, date: today });
    if (existing) {
      return res.status(400).json({ message: 'Already clocked in for today' });
    }

    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) {
      return res.status(400).json({ message: 'Image file is required' });
    }

    const client = getS3Client();
    const sanitizeFilename = (name: string): string =>
      name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
    const safeName = sanitizeFilename(file.originalname || 'face.jpg');
    const key = ['orgs', org_id, 'attendance', 'face-clock', `${Date.now()}-${safeName}`].join('/');

    try {
      await client.send(
        new PutObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype,
        }),
      );

      const match = await identifyUserByS3Image(
        org_id,
        env.S3_BUCKET as string,
        key,
        threshold ?? 90,
      );

      if (!match) {
        return res.status(404).json({ message: 'No matching face found for this user' });
      }

      if (match.userId !== user_id) {
        return res.status(403).json({
          message: 'Face verification failed for the logged-in user',
        });
      }

      const created = await AttendanceLog.query().insert({
        org_id,
        user_id,
        date: today,
        clock_in_time: new Date().toISOString(),
        status: 'PRESENT',
        ...(latitude !== undefined && longitude !== undefined
          ? { punch_in_lat: String(latitude), punch_in_long: String(longitude) }
          : {}),
      });
      await ActivityLogService.recordActivitySafely({
        org_id,
        actor_user_id: user_id,
        target_user_id: user_id,
        entity_type: ACTIVITY_ENTITY_TYPES.ATTENDANCE_LOG,
        entity_id: created.id,
        activity_type: ACTIVITY_TYPES.CLOCKED_IN,
        metadata: {
          date: today,
          source: 'FACE_VERIFY_AND_CLOCK_IN',
        },
      });
      const user = await AttendanceController.buildFaceClockUserPayload(org_id, user_id);

      return res.status(201).json({
        message: 'Clocked in successfully via face verification',
        mode: 'CLOCK_IN',
        attendance_log_id: created.id,
        user,
        similarity: match.similarity,
      });
    } catch {
      return res.status(500).json({
        message: 'Failed to process facial verification clock-in request',
      });
    }
  }

  /**
   * Admin-only facial recognition clock endpoint.
   * - Identifies the employee from a face image using pgvector embeddings.
   * - If the user has not clocked in today, this will clock them in.
   * - If the user has already clocked in but not clocked out, this will clock them out.
   */
  static async faceClock(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = attendanceFaceClockSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { threshold, latitude, longitude } = parsed.data;
    const org_id = req.user.org_id;

    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) {
      return res.status(400).json({ message: 'Image file is required' });
    }

    const client = getS3Client();
    const sanitizeFilename = (name: string): string =>
      name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
    const safeName = sanitizeFilename(file.originalname || 'face.jpg');
    const key = ['orgs', org_id, 'attendance', 'face-clock', `${Date.now()}-${safeName}`].join('/');

    try {
      await client.send(
        new PutObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype,
        }),
      );

      const match = await identifyUserByS3Image(
        org_id,
        env.S3_BUCKET as string,
        key,
        threshold ?? 90,
      );

      if (!match) {
        return res.status(404).json({ message: 'No matching face found for this organization' });
      }

      const user_id = match.userId;
      const user = await AttendanceController.buildFaceClockUserPayload(org_id, user_id);
      const today = getTodayDate();

      const log = await AttendanceLog.query().findOne({ org_id, user_id, date: today });

      // No log yet -> clock in
      if (!log) {
        const created = await AttendanceLog.query().insert({
          org_id,
          user_id,
          date: today,
          clock_in_time: new Date().toISOString(),
          status: 'PRESENT',
          ...(latitude !== undefined && longitude !== undefined
            ? { punch_in_lat: String(latitude), punch_in_long: String(longitude) }
            : {}),
        });
        await ActivityLogService.recordActivitySafely({
          org_id,
          actor_user_id: req.user.id,
          target_user_id: user_id,
          entity_type: ACTIVITY_ENTITY_TYPES.ATTENDANCE_LOG,
          entity_id: created.id,
          activity_type: ACTIVITY_TYPES.CLOCKED_IN,
          metadata: {
            date: today,
            source: 'DEVICE_FACE_CLOCK',
          },
        });

        return res.status(201).json({
          message: 'Clocked in successfully via face recognition',
          mode: 'CLOCK_IN',
          attendance_log_id: created.id,
          user,
          similarity: match.similarity,
        });
      }

      // Already clocked out
      if (log.clock_out_time) {
        return res.status(400).json({
          message: 'User has already clocked out for today',
          mode: 'NONE',
          user,
        });
      }

      // Clock out with the same work-hour calculation as the standard endpoint
      const completedBreaks = await AttendanceBreak.query()
        .where('attendance_log_id', log.id)
        .whereNotNull('end_time')
        .select('start_time', 'end_time');

      const breakMinutes = calculateBreakMinutes(completedBreaks as any);
      const clockInTime = log.clock_in_time ? new Date(log.clock_in_time) : new Date();
      const totalMinutes = (Date.now() - clockInTime.getTime()) / 60000 - Math.max(0, breakMinutes);
      const roundedMinutes = Math.max(0, Math.round(totalMinutes));
      const totalHours = Math.max(0, roundedMinutes / 60);
      const roundedHours = Math.round(totalHours * 100) / 100;

      await AttendanceLog.query()
        .patch({
          clock_out_time: new Date().toISOString(),
          total_work_hours: roundedHours,
        })
        .where('id', log.id);
      await ActivityLogService.recordActivitySafely({
        org_id,
        actor_user_id: req.user.id,
        target_user_id: user_id,
        entity_type: ACTIVITY_ENTITY_TYPES.ATTENDANCE_LOG,
        entity_id: log.id,
        activity_type: ACTIVITY_TYPES.CLOCKED_OUT,
        metadata: {
          date: today,
          source: 'DEVICE_FACE_CLOCK',
          total_work_hours: roundedHours,
        },
      });

      return res.json({
        message: 'Clocked out successfully via face recognition',
        mode: 'CLOCK_OUT',
        user,
        total_work_hours: roundedHours,
        total_work_minutes: roundedMinutes,
        similarity: match.similarity,
      });
    } catch {
      return res.status(500).json({
        message: 'Failed to process facial recognition clock request',
      });
    }
  }

  static async clockOut(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = attendanceClockOutSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { latitude, longitude } = parsed.data;
    const org_id = req.user.org_id;
    //const todayStr = getTodayDate();
    const user_id = req.user.id;
    const today = getTodayDate();

    const log = await AttendanceLog.query().findOne({ org_id, user_id, date: today });
    if (!log) {
      return res.status(400).json({ message: 'You have not clocked in today' });
    }

    if (log.clock_out_time) {
      return res.status(400).json({ message: 'Already clocked out for today' });
    }

    const activeBreak = await AttendanceBreak.query()
      .where('attendance_log_id', log.id)
      .whereNull('end_time')
      .first();

    if (activeBreak) {
      return res.status(400).json({ message: 'Cannot clock out while on break' });
    }

    const completedBreaks = await AttendanceBreak.query()
      .where('attendance_log_id', log.id)
      .whereNotNull('end_time')
      .select('start_time', 'end_time');

    const breakMinutes = calculateBreakMinutes(completedBreaks as any);
    const clockInTime = log.clock_in_time ? new Date(log.clock_in_time) : new Date();
    const totalMinutes = (Date.now() - clockInTime.getTime()) / 60000 - Math.max(0, breakMinutes);
    const roundedMinutes = Math.max(0, Math.round(totalMinutes));
    const totalHours = Math.max(0, roundedMinutes / 60);
    const roundedHours = Math.round(totalHours * 100) / 100;

    // Normalize and validate coordinates before saving. If the client didn't send
    // valid lat/long, keep the existing stored values instead of overwriting them
    // with incorrect strings.
    const latNum = typeof latitude === 'number' ? latitude : Number(latitude);
    const lonNum = typeof longitude === 'number' ? longitude : Number(longitude);
    const hasValidLat = Number.isFinite(latNum) && latNum >= -90 && latNum <= 90;
    const hasValidLon = Number.isFinite(lonNum) && lonNum >= -180 && lonNum <= 180;

    const patch: PartialModelObject<AttendanceLog> = {
      clock_out_time: new Date().toISOString(),
      total_work_hours: roundedHours,
    };
    if (hasValidLat && hasValidLon) {
      // Store as strings to match DECIMAL column behavior from pg/knex.
      (patch as any).punch_out_lat = String(latNum);
      (patch as any).punch_out_long = String(lonNum);
    }

    await AttendanceLog.query().patch(patch).where('id', log.id);
    await ActivityLogService.recordActivitySafely({
      org_id,
      actor_user_id: user_id,
      target_user_id: user_id,
      entity_type: ACTIVITY_ENTITY_TYPES.ATTENDANCE_LOG,
      entity_id: log.id,
      activity_type: ACTIVITY_TYPES.CLOCKED_OUT,
      metadata: {
        date: today,
        source: 'CLOCK_OUT',
        total_work_hours: roundedHours,
      },
    });

    return res.json({
      message: 'Clocked out successfully',
      total_work_hours: roundedHours,
      total_work_minutes: roundedMinutes,
    });
  }

  static async startBreak(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = attendanceBreakStartSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten((issue) => issue.message).fieldErrors,
      });
    }

    const org_id = req.user.org_id;
    const user_id = req.user.id;
    const today = getTodayDate();

    const log = await AttendanceLog.query().findOne({ org_id, user_id, date: today });
    if (!log) {
      return res.status(400).json({ message: 'You have not clocked in today' });
    }

    if (log.clock_out_time) {
      return res.status(400).json({ message: 'You have already clocked out' });
    }

    const activeBreak = await AttendanceBreak.query()
      .where('attendance_log_id', log.id)
      .whereNull('end_time')
      .first();

    if (activeBreak) {
      return res.status(400).json({ message: 'You are already on break' });
    }

    const breakInsert: PartialModelObject<AttendanceBreak> = {
      attendance_log_id: String(log.id),
      break_type: parsed.data.break_type as any,
      start_time: new Date().toISOString(),
    };

    await AttendanceBreak.query().insert(breakInsert);

    return res.status(201).json({ message: 'Break started' });
  }

  static async endBreak(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const org_id = req.user.org_id;
    const user_id = req.user.id;
    const today = getTodayDate();

    const log = await AttendanceLog.query().findOne({ org_id, user_id, date: today });
    if (!log) {
      return res.status(400).json({ message: 'You have not clocked in today' });
    }

    const activeBreak = await AttendanceBreak.query()
      .where('attendance_log_id', log.id)
      .whereNull('end_time')
      .first();

    if (!activeBreak) {
      return res.status(400).json({ message: 'No active break found' });
    }

    await AttendanceBreak.query()
      .patch({ end_time: new Date().toISOString() })
      .where('id', activeBreak.id);

    const breaks = await AttendanceBreak.query()
      .where('attendance_log_id', log.id)
      .whereNotNull('end_time')
      .select('start_time', 'end_time');

    const totalBreakTime = Math.round(calculateBreakMinutes(breaks as any));
    const shift = await resolveShift(org_id, user_id);
    const shiftLimit = shift?.break_duration_mins ?? 0;
    const isExcess = shiftLimit > 0 && totalBreakTime > shiftLimit;

    return res.json({
      message: isExcess ? 'Excess Break Time' : 'Break ended',
      total_break_time: totalBreakTime,
      shift_break_limit: shiftLimit,
      is_excess_break: isExcess,
    });
  }

  static async getDashboardStatus(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const org_id = req.user.org_id;
    const user_id = req.user.id;
    const today = getTodayDate();

    const log = await AttendanceLog.query().findOne({ org_id, user_id, date: today });

    // Get shift info for timestamps
    const shift = await resolveShift(org_id, user_id);
    const shiftStartTime = shift?.start_time ?? null;
    const shiftEndTime = shift?.end_time ?? null;

    if (!log) {
      return res.json({
        state: 'NOT_CLOCKED_IN',
        clock_in_time: null,
        clock_out_time: null,
        total_work_seconds: 0,
        total_break_seconds: 0,
        shift_break_limit_seconds: 0,
        is_excess_break: false,
        shift_start_time: timeStringToISO(today, shiftStartTime),
        shift_end_time: timeStringToISO(today, shiftEndTime),
      });
    }

    const breaks = await AttendanceBreak.query()
      .where('attendance_log_id', log.id)
      .select('start_time', 'end_time');

    // Convert breaks to the format expected by calculateWorkSeconds
    const breaksArray = breaks.map((brk: any) => ({
      start_time: brk.start_time,
      end_time: brk.end_time,
    }));

    // Check for active break (no end_time)
    const now = new Date();
    let activeBreak: any | null = null;
    for (const brk of breaksArray) {
      if (!brk.end_time) {
        activeBreak = brk;
        break;
      }
    }

    // Use the same end time logic as buildCalendarEntry for consistency
    const endTimeForBreaks = log.clock_out_time ? new Date(log.clock_out_time) : now;

    // Calculate break seconds using the same helper as other APIs
    const totalBreakSeconds = calculateBreakSeconds(breaksArray, endTimeForBreaks);

    const shiftLimitMinutes = shift?.break_duration_mins ?? 0;
    const shiftLimitSeconds = Math.max(0, shiftLimitMinutes * 60);
    const isExcess = shiftLimitSeconds > 0 && totalBreakSeconds > shiftLimitSeconds;

    let state: 'NOT_CLOCKED_IN' | 'PRESENT' | 'ON_BREAK' | 'CLOCKED_OUT' = 'PRESENT';
    if (log.clock_out_time) {
      state = 'CLOCKED_OUT';
    } else if (activeBreak) {
      state = 'ON_BREAK';
    }

    // Use the same calculateWorkSeconds helper as other APIs for consistency
    // This ensures all APIs return the same total_work_seconds for the same attendance record
    let totalWorkSeconds = 0;
    if (log.clock_in_time) {
      if (log.clock_out_time) {
        // Completed day - use calculateWorkSeconds with all breaks (same as buildCalendarEntry)
        totalWorkSeconds = calculateWorkSeconds(log.clock_in_time, log.clock_out_time, breaksArray);
      } else {
        // In-progress day - if on break, exclude active break time
        if (state === 'ON_BREAK' && activeBreak) {
          // Calculate work seconds up to the break start time (exclude active break)
          const breaksUpToBreak = breaksArray.filter((brk) => brk.end_time !== null);
          totalWorkSeconds = calculateWorkSeconds(
            log.clock_in_time,
            activeBreak.start_time,
            breaksUpToBreak,
          );
        } else {
          // Calculate work seconds up to now, excluding all breaks (including active break)
          totalWorkSeconds = calculateWorkSeconds(
            log.clock_in_time,
            now.toISOString(),
            breaksArray,
          );
        }
      }
    }

    return res.json({
      state,
      clock_in_time: log.clock_in_time || null,
      clock_out_time: log.clock_out_time || null,
      total_work_seconds: totalWorkSeconds,
      total_break_seconds: totalBreakSeconds,
      shift_break_limit_seconds: shiftLimitSeconds,
      is_excess_break: isExcess,
      shift_start_time: timeStringToISO(today, shiftStartTime),
      shift_end_time: timeStringToISO(today, shiftEndTime),
    });
  }

  static async getCalendar(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = attendanceCalendarQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const org_id = req.user.org_id;
    const user_id = req.user.id;

    // Calculate date range
    let startDate: string;
    let endDate: string;

    if (parsed.data.start_date && parsed.data.end_date) {
      startDate = parsed.data.start_date;
      endDate = parsed.data.end_date;
    } else if (parsed.data.month && parsed.data.year) {
      // First day of the month
      startDate = `${parsed.data.year}-${String(parsed.data.month).padStart(2, '0')}-01`;
      // Last day of the month
      const lastDay = new Date(parsed.data.year, parsed.data.month, 0).getDate();
      endDate = `${parsed.data.year}-${String(parsed.data.month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    } else {
      return res.status(400).json({ message: 'Invalid date range parameters' });
    }

    // Use shared calendar building helper
    const { entries: calendarEntries } = await buildCalendarEntries(
      org_id,
      user_id,
      startDate,
      endDate,
    );

    return res.json({
      start_date: startDate,
      end_date: endDate,
      calendar: calendarEntries,
    });
  }

  static async getWeeklySummary(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = attendanceWeeklySummaryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const org_id = req.user.org_id;
    const user_id = req.user.id;
    const { start_date, end_date } = parsed.data;

    // Use shared calendar building helper (reuses Calendar API logic)
    const { entries: calendarEntries } = await buildCalendarEntries(
      org_id,
      user_id,
      start_date,
      end_date,
    );

    // Transform calendar entries to daily_logs format
    const dailyLogs: Array<{
      date: string;
      status: 'PRESENT' | 'LATE' | 'ON_TIME' | 'ABSENT' | 'LEAVE' | 'HOLIDAY' | 'HALF_DAY' | 'WFH';
      login_time: string | null;
      logout_time: string | null;
      total_break_seconds: number;
      effective_seconds: number;
      overtime_seconds: number;
      is_late_arrival: boolean;
      late_by_minutes: number;
      holiday_title?: string | null;
      leave_session?: LeaveDaySession | null;
      session_window?: LeaveSessionWindow | null;
      is_wfh?: boolean;
    }> = [];

    let totalWorkSeconds = 0;
    let totalLoginMinutes = 0;
    let loginCount = 0;
    let lateDays = 0;
    let leaveDays = 0;
    let holidayDays = 0;

    for (const entry of calendarEntries) {
      if (entry.status === 'LEAVE') {
        dailyLogs.push({
          date: entry.date,
          status: 'LEAVE',
          login_time: null,
          logout_time: null,
          total_break_seconds: 0,
          effective_seconds: 0,
          overtime_seconds: 0,
          is_late_arrival: false,
          late_by_minutes: 0,
          leave_session: entry.leave_session ?? 'FULL',
          session_window: entry.session_window ?? null,
        });
        leaveDays++;
        continue;
      }
      if (entry.status === 'HALF_DAY') {
        dailyLogs.push({
          date: entry.date,
          status: 'HALF_DAY',
          login_time: null,
          logout_time: null,
          total_break_seconds: 0,
          effective_seconds: 0,
          overtime_seconds: 0,
          is_late_arrival: false,
          late_by_minutes: 0,
          leave_session: entry.leave_session ?? null,
          session_window: entry.session_window ?? null,
        });
        continue;
      }
      // A worked day that is also a half-day leave contributes half a leave day.
      if (entry.leave_session && entry.leave_session !== 'FULL') {
        leaveDays += 0.5;
      }
      if (entry.status === 'HOLIDAY') {
        dailyLogs.push({
          date: entry.date,
          status: 'HOLIDAY',
          login_time: null,
          logout_time: null,
          total_break_seconds: 0,
          effective_seconds: 0,
          overtime_seconds: 0,
          is_late_arrival: false,
          late_by_minutes: 0,
          holiday_title: entry.holiday_title ?? null,
        });
        holidayDays++;
        continue;
      }
      // Transform calendar entry to daily log format
      // Check if entry has both clock_in and clock_out (complete day)
      if (entry.clock_in_time && entry.clock_out_time && entry.total_work_seconds !== null) {
        const workSeconds = entry.total_work_seconds ?? 0;
        totalWorkSeconds += workSeconds;

        // Calculate login time in minutes since midnight (parse ISO timestamp, convert to IST)
        const clockInDate = new Date(entry.clock_in_time);
        if (!Number.isNaN(clockInDate.getTime())) {
          const istClockInDate = new Date(clockInDate.getTime() + IST_OFFSET_MS);
          const loginMinutes = istClockInDate.getUTCHours() * 60 + istClockInDate.getUTCMinutes();
          totalLoginMinutes += loginMinutes;
          loginCount++;
        }

        if (entry.is_late_arrival) {
          lateDays++;
        }

        dailyLogs.push({
          date: entry.date,
          status: entry.status === 'WFH' ? 'WFH' : entry.is_late_arrival ? 'LATE' : 'ON_TIME',
          login_time: entry.clock_in_time,
          logout_time: entry.clock_out_time,
          total_break_seconds: entry.total_break_seconds ?? 0,
          effective_seconds: entry.effective_seconds ?? 0,
          overtime_seconds: entry.overtime_seconds ?? 0,
          is_late_arrival: entry.is_late_arrival ?? false,
          late_by_minutes: entry.late_by_minutes ?? 0,
          leave_session: entry.leave_session ?? null,
          session_window: entry.session_window ?? null,
          is_wfh: entry.is_wfh ?? false,
        });
      } else if (entry.clock_in_time) {
        // Has clock in but no clock out – status should still be based solely
        // on arrival time (within or beyond grace period).
        const clockInDate = new Date(entry.clock_in_time);
        if (!Number.isNaN(clockInDate.getTime())) {
          const loginMinutes = clockInDate.getHours() * 60 + clockInDate.getMinutes();
          totalLoginMinutes += loginMinutes;
          loginCount++;
        }

        const isLateArrival = entry.is_late_arrival ?? false;

        dailyLogs.push({
          date: entry.date,
          status: entry.status === 'WFH' ? 'WFH' : isLateArrival ? 'LATE' : 'ON_TIME',
          login_time: entry.clock_in_time,
          logout_time: null,
          total_break_seconds: entry.total_break_seconds ?? 0,
          effective_seconds: entry.effective_seconds ?? 0,
          overtime_seconds: 0,
          is_late_arrival: isLateArrival,
          late_by_minutes: entry.late_by_minutes ?? 0,
          leave_session: entry.leave_session ?? null,
          session_window: entry.session_window ?? null,
          is_wfh: entry.is_wfh ?? false,
        });
        if (isLateArrival) {
          lateDays++;
        }
      } else {
        // No attendance log - ABSENT
        dailyLogs.push({
          date: entry.date,
          status: 'ABSENT',
          login_time: null,
          logout_time: null,
          total_break_seconds: 0,
          effective_seconds: 0,
          overtime_seconds: 0,
          is_late_arrival: false,
          late_by_minutes: 0,
          leave_session: entry.leave_session ?? null,
          session_window: entry.session_window ?? null,
          is_wfh: false,
        });
      }
    }

    // Calculate summary
    const totalHours = totalWorkSeconds / 3600;
    const averageLoginMinutes = loginCount > 0 ? Math.round(totalLoginMinutes / loginCount) : 0;
    const avgHours = Math.floor(averageLoginMinutes / 60);
    const avgMins = averageLoginMinutes % 60;
    const averageLoginTime = `${String(avgHours).padStart(2, '0')}:${String(avgMins).padStart(2, '0')}`;

    // Calculate total overtime
    const totalOvertimeSeconds = dailyLogs.reduce((sum, log) => sum + log.overtime_seconds, 0);

    return res.json({
      start_date,
      end_date,
      summary: {
        total_days: dailyLogs.length,
        total_work_seconds: totalWorkSeconds,
        total_hours_decimal: Math.round(totalHours * 100) / 100,
        average_login_time: averageLoginTime,
        late_days: lateDays,
        leave_days: leaveDays,
        holiday_days: holidayDays,
        total_overtime_seconds: totalOvertimeSeconds,
      },
      daily_logs: dailyLogs,
    });
  }

  static async getMonthlyPerformance(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = attendanceMonthlyPerformanceQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const org_id = req.user.org_id;
    const user_id = req.user.id;
    const { month, year } = parsed.data;

    // Calculate date range for the month
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    // Use shared calendar building helper (reuses Calendar API logic)
    const { entries: calendarEntries, holidayDays } = await buildCalendarEntries(
      org_id,
      user_id,
      startDate,
      endDate,
    );

    // Count attendance types for performance metrics
    let presentDays = 0;
    let absentDays = 0;
    let leaveDays = 0;
    let halfDayCount = 0;
    let lateArrivalCount = 0;

    for (const entry of calendarEntries) {
      if (entry.status === 'PRESENT' || entry.status === 'LATE') {
        presentDays++;
        if (entry.leave_session && entry.leave_session !== 'FULL') {
          leaveDays += 0.5;
        }
      } else if (entry.status === 'ABSENT') {
        absentDays++;
      } else if (entry.status === 'LEAVE') {
        leaveDays++;
      } else if (entry.status === 'HALF_DAY') {
        halfDayCount++;
      }

      // Late marks should come strictly from actual late arrivals (beyond grace).
      if (entry.is_late_arrival) {
        lateArrivalCount++;
      }
    }

    // Score from scheduled days only (calendar rows); holiday_days is informational (org holidays on working weekdays).
    const totalWorkingDays = presentDays + absentDays + leaveDays + halfDayCount;
    const totalScore =
      totalWorkingDays > 0 ? Math.round((presentDays / totalWorkingDays) * 100) : 0;

    // Generate pay impact alerts
    const payImpactAlerts: Array<{
      type: string;
      message: string;
      late_count?: number;
      threshold?: number;
    }> = [];

    if (lateArrivalCount >= 2) {
      payImpactAlerts.push({
        type: 'LATE_MARKS',
        message: `Pay Impact Alert. You have ${lateArrivalCount} Late Marks. One more will result in a half-day deduction.`,
        late_count: lateArrivalCount,
        threshold: 3,
      });
    }

    return res.json({
      month,
      year,
      performance: {
        total_score: totalScore,
        present_days: presentDays,
        leave_days: leaveDays,
        absent_days: absentDays,
        holiday_days: holidayDays,
        half_day_count: halfDayCount,
        late_arrival_count: lateArrivalCount,
      },
      calendar: calendarEntries,
      pay_impact_alerts: payImpactAlerts,
    });
  }

  // Admin/HR - organization-wide attendance dashboard (cards + multi-month overview)
  // Note: This endpoint ONLY uses 'date' and 'months' parameters. Any 'from_date' or 'to_date'
  // parameters in the query are ignored. The date range is calculated as: [focusDate - months, focusDate]
  static async getOrgDashboard(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Only 'date' and 'months' are accepted. 'from_date' and 'to_date' are ignored.
    const parsed = attendanceOrgDashboardQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const org_id = req.user.org_id;
    const isManager = req.user.role === 'manager';
    let managedDepartmentIds: string[] = [];
    if (isManager) {
      managedDepartmentIds = await getManagedDepartmentIds(org_id, req.user.id);
    }

    const now = new Date();
    // Use 'date' parameter or default to today. 'from_date' and 'to_date' are ignored.
    const focusDate = parsed.data.date ? new Date(parsed.data.date) : now;
    const focusDateStr = formatDateLocal(focusDate);

    const yesterday = new Date(focusDate);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = formatDateLocal(yesterday);

    // Use 'months' parameter or default to 6. This determines how many months back to show.
    const months = parsed.data.months ?? 6;

    // Determine overview range: exactly N months back from focus date
    // Start date = focusDate - months, End date = focusDate
    // This is calculated based on 'date' and 'months' only, ignoring any 'from_date'/'to_date'
    const overviewEnd = new Date(focusDate);
    overviewEnd.setHours(23, 59, 59, 999); // End of focus date

    const overviewStart = new Date(focusDate);
    overviewStart.setMonth(overviewStart.getMonth() - months);
    overviewStart.setHours(0, 0, 0, 0); // Start of day

    const overviewStartStr = formatDateLocal(overviewStart);
    const overviewEndStr = formatDateLocal(overviewEnd);

    // Load org users for attendance scope (employee/hr/manager, active & not soft-deleted)
    // Only include users who joined on or before the focus date (matching users endpoint logic)
    const employees = await User.query()
      .alias('u')
      .leftJoin('departments as d', 'd.id', 'u.department_id')
      .where('u.org_id', org_id)
      .whereIn('u.role', ORG_USER_ROLES) // Include employee, hr, manager (exclude admin)
      .whereIn('u.status', ATTENDANCE_ACTIVE_EMPLOYEE_STATUSES as readonly string[])
      .whereNull('u.deleted_at')
      .whereRaw('COALESCE(u.date_of_joining::date, u.created_at::date) <= ?::date', [focusDateStr])
      .modify((qb) => {
        // For managers, restrict to their managed departments only
        if (isManager) {
          if (managedDepartmentIds.length === 0) {
            qb.whereRaw('1 = 0');
            return;
          }

          // Include:
          // - employees/HR directly in managed departments (department_id match)
          // - managers assigned to those departments via department_managers
          const managerSubquery = DepartmentManager.query()
            .alias('dm')
            .whereIn('dm.department_id', managedDepartmentIds)
            .select('dm.manager_id');

          qb.where((b) => {
            b.whereIn('u.department_id', managedDepartmentIds).orWhereIn('u.id', managerSubquery);
          });
        }
      })
      .select('u.id', 'u.role', 'u.department_id', 'd.working_days as department_working_days');

    const managerIdsNeedingScheduleFallback = (employees as any[])
      .filter(
        (r: any) =>
          r.role === 'manager' &&
          !(
            r.department_id &&
            Array.isArray(r.department_working_days) &&
            r.department_working_days.length > 0
          ),
      )
      .map((r: any) => String(r.id));
    const overviewManagedScheduleByManagerId =
      await fetchPrimaryManagedDepartmentScheduleByManagerIds(
        org_id,
        managerIdsNeedingScheduleFallback,
      );

    const userScheduleById = new Map<
      string,
      { departmentId: string | null; workingDays: string[] | null }
    >();
    for (const row of employees as any[]) {
      const eff = resolveEffectiveAttendanceSchedule(
        {
          role: row.role,
          department_id: row.department_id ?? null,
          department_working_days: row.department_working_days,
        },
        overviewManagedScheduleByManagerId.get(String(row.id)),
      );
      userScheduleById.set(row.id, {
        departmentId: eff.departmentId,
        workingDays: eff.workingDays,
      });
    }

    const employeeIds = employees.map((e) => e.id);
    const totalEmployees = employeeIds.length;

    if (totalEmployees === 0) {
      return res.json({
        date: focusDateStr,
        months,
        summary_today: {
          total_employees: 0,
          present: {
            count: 0,
            change_vs_yesterday: 0,
            on_time: 0,
            late: 0,
            half_day_worked_count: 0,
          },
          on_leave: {
            count: 0,
            change_vs_yesterday: 0,
            by_type: [],
          },
          on_halfday: {
            count: 0,
            change_vs_yesterday: 0,
            by_type: [],
          },
          absent: { count: 0, change_vs_yesterday: 0 },
        },
        overview: {
          period: {
            start_date: overviewStartStr,
            end_date: overviewEndStr,
          },
          by_month: [],
        },
      });
    }

    const overviewHolidaySetByUserId = await fetchEffectiveHolidayDateSetsForUsers(
      org_id,
      employeeIds.map(String),
      overviewStartStr,
      overviewEndStr,
    );
    const overviewHolidaySet = await fetchOrgHolidayDateSet(
      org_id,
      overviewStartStr,
      overviewEndStr,
    );

    // Attendance logs for overview period
    const logs = await AttendanceLog.query()
      .alias('al')
      .where('al.org_id', org_id)
      .whereIn('al.user_id', employeeIds)
      .whereBetween('al.date', [overviewStartStr, overviewEndStr])
      .select('al.user_id', 'al.date', 'al.clock_in_time', 'al.total_work_hours');

    // Map date -> map of user_id -> log
    const logsByDate = new Map<string, Map<string, AttendanceLog>>();
    for (const log of logs) {
      const dateKey = normalizeDate((log as any).date);
      if (!dateKey) continue;
      if (!logsByDate.has(dateKey)) {
        logsByDate.set(dateKey, new Map());
      }
      logsByDate.get(dateKey)!.set((log as any).user_id, log);
    }

    // Leave requests overlapping overview period (only approved leaves)
    const leaves = await LeaveRequest.query()
      .alias('lr')
      .where('lr.org_id', org_id)
      .whereIn('lr.user_id', employeeIds)
      .where('lr.status', 'APPROVED')
      .where((qb) => {
        qb.whereBetween('lr.start_date', [overviewStartStr, overviewEndStr])
          .orWhereBetween('lr.end_date', [overviewStartStr, overviewEndStr])
          .orWhere((inner) =>
            inner
              .where('lr.start_date', '<=', overviewStartStr)
              .where('lr.end_date', '>=', overviewEndStr),
          );
      })
      .select('lr.user_id', 'lr.start_date', 'lr.end_date', 'lr.leave_type_id', 'lr.day_session');

    // Build date -> user_id map for leaves
    const leavesByDate = new Map<
      string,
      Map<string, { leave_type_id: string; day_session: LeaveDaySession }>
    >();
    for (const lr of leaves as any[]) {
      const start = new Date(lr.start_date);
      const end = new Date(lr.end_date);
      const daySession = (lr.day_session ?? 'FULL') as LeaveDaySession;
      let current = new Date(start);
      while (current <= end) {
        const key = formatDateLocal(current);
        if (key < overviewStartStr || key > overviewEndStr) {
          current.setDate(current.getDate() + 1);
          continue;
        }
        if (!leavesByDate.has(key)) {
          leavesByDate.set(key, new Map());
        }
        const dayLeaveMap = leavesByDate.get(key)!;
        const existing = dayLeaveMap.get(lr.user_id);
        dayLeaveMap.set(lr.user_id, {
          leave_type_id: lr.leave_type_id,
          day_session: mergeLeaveDaySessions(existing?.day_session, daySession) ?? daySession,
        });
        current.setDate(current.getDate() + 1);
      }
    }

    const dashboardTodayStr = getTodayDate();

    // Helper to classify counts for a given date (scheduled users + voluntary punches on off-days)
    const classifyForDate = (dateStr: string) => {
      const logMap = logsByDate.get(dateStr) ?? new Map<string, AttendanceLog>();
      const leaveMap =
        leavesByDate.get(dateStr) ??
        new Map<string, { leave_type_id: string; day_session: LeaveDaySession }>();

      let presentCount = 0;
      let onLeaveCount = 0;
      let onHalfDayCount = 0;
      let halfDayWorkedCount = 0;
      let absentCount = 0;
      let scheduledCount = 0;

      for (const id of employeeIds) {
        const sched = userScheduleById.get(id);
        const scheduled = isUserAttendanceScheduledDay({
          dateStr,
          holidaySet: overviewHolidaySetByUserId.get(String(id)) ?? overviewHolidaySet,
          departmentId: sched?.departmentId,
          workingDays: sched?.workingDays,
        });
        const log = logMap.get(id);
        const hasClockIn = Boolean(log?.clock_in_time);
        if (!scheduled && !hasClockIn) {
          continue;
        }
        scheduledCount += 1;

        const leaveEntry = leaveMap.get(id);
        const derived = resolveAdminAttendanceStatus({
          leaveSession: leaveEntry?.day_session,
          hasClockIn,
          evaluationDateStr: dateStr,
          todayStr: dashboardTodayStr,
        });

        if (derived === 'LEAVE') {
          onLeaveCount += 1;
        } else if (derived === 'HALF_DAY') {
          onHalfDayCount += 1;
        } else if (hasClockIn) {
          presentCount += 1;
          if (isHalfDayLeaveSession(leaveEntry?.day_session)) {
            halfDayWorkedCount += 1;
          }
        } else {
          absentCount += 1;
        }
      }

      return {
        presentCount,
        onLeaveCount,
        onHalfDayCount,
        halfDayWorkedCount,
        absentCount,
        scheduledCount,
        logMap,
        leaveMap,
      };
    };

    // Today vs yesterday summaries
    const todayInfo = classifyForDate(focusDateStr);
    const yesterdayInfo = classifyForDate(yesterdayStr);

    // Late vs on-time: everyone with a log today (including voluntary off-day / holiday punches).
    const presentUserIdsToday = Array.from(todayInfo.logMap.keys());

    const lateGracePeriodMins = await getOrgLateGracePeriodMins(org_id);

    let onTimeCount = 0;
    let lateCount = 0;

    if (presentUserIdsToday.length > 0) {
      const userRows = await User.query()
        .alias('u')
        .leftJoin('departments as d', 'd.id', 'u.department_id')
        .leftJoin('work_shifts as ws_user', 'ws_user.id', 'u.shift_id')
        .leftJoin('work_shifts as ws_dept', 'ws_dept.id', 'd.default_shift_id')
        .where('u.org_id', org_id)
        .whereIn('u.id', presentUserIdsToday)
        .select(
          'u.id',
          'u.role',
          'ws_user.start_time as user_shift_start_time',
          'ws_user.end_time as user_shift_end_time',
          'ws_user.break_start_time as user_shift_break_start_time',
          'ws_user.break_end_time as user_shift_break_end_time',
          'ws_dept.start_time as dept_shift_start_time',
          'ws_dept.end_time as dept_shift_end_time',
          'ws_dept.break_start_time as dept_shift_break_start_time',
          'ws_dept.break_end_time as dept_shift_break_end_time',
        );

      const userShiftMap = new Map<
        string,
        { role: string; shift_start_time: string | null; shift_end_time: string | null }
      >();

      for (const row of userRows as any[]) {
        const shift_start_time = row.user_shift_start_time ?? row.dept_shift_start_time ?? null;
        const shift_end_time = row.user_shift_end_time ?? row.dept_shift_end_time ?? null;
        userShiftMap.set(row.id, { role: row.role, shift_start_time, shift_end_time });
      }

      for (const userId of presentUserIdsToday) {
        const log = todayInfo.logMap.get(userId) as any;
        const baseShiftInfo = userShiftMap.get(userId) ?? {
          role: 'employee',
          shift_start_time: null,
          shift_end_time: null,
        };
        const shiftInfo = { ...baseShiftInfo };

        // Keep dashboard late/on-time classification in sync with the users table endpoint:
        // for managers with no configured shift, fall back to resolveShift().
        if (
          shiftInfo.role === 'manager' &&
          (!shiftInfo.shift_start_time || parseTimeToMinutes(shiftInfo.shift_start_time) === 0) &&
          (!shiftInfo.shift_end_time || parseTimeToMinutes(shiftInfo.shift_end_time) === 0)
        ) {
          const resolvedShift = await resolveShift(org_id, userId);
          if (resolvedShift) {
            shiftInfo.shift_start_time = resolvedShift.start_time ?? shiftInfo.shift_start_time;
            shiftInfo.shift_end_time = resolvedShift.end_time ?? shiftInfo.shift_end_time;
          }
        }

        const lateInfo = calculateLateArrival(
          log.clock_in_time,
          shiftInfo.shift_start_time,
          lateGracePeriodMins,
        );
        if (lateInfo.isLate) {
          lateCount += 1;
        } else {
          onTimeCount += 1;
        }
      }
    }

    // On-leave and on-halfday breakdown by type for today (scheduled-to-work users only)
    const leaveTypeCountsToday = new Map<string, number>();
    const halfDayTypeCountsToday = new Map<string, number>();
    for (const [leaveUserId, entry] of todayInfo.leaveMap.entries()) {
      const sched = userScheduleById.get(leaveUserId);
      if (
        !isUserAttendanceScheduledDay({
          dateStr: focusDateStr,
          holidaySet: overviewHolidaySetByUserId.get(String(leaveUserId)) ?? overviewHolidaySet,
          departmentId: sched?.departmentId,
          workingDays: sched?.workingDays,
        })
      ) {
        continue;
      }
      const log = todayInfo.logMap.get(leaveUserId);
      const derived = resolveAdminAttendanceStatus({
        leaveSession: entry.day_session,
        hasClockIn: Boolean(log?.clock_in_time),
        evaluationDateStr: focusDateStr,
        todayStr: dashboardTodayStr,
      });
      if (derived === 'LEAVE') {
        leaveTypeCountsToday.set(
          entry.leave_type_id,
          (leaveTypeCountsToday.get(entry.leave_type_id) ?? 0) + 1,
        );
      } else if (derived === 'HALF_DAY') {
        halfDayTypeCountsToday.set(
          entry.leave_type_id,
          (halfDayTypeCountsToday.get(entry.leave_type_id) ?? 0) + 1,
        );
      }
    }

    const leaveTypeIdsToday = Array.from(
      new Set([...leaveTypeCountsToday.keys(), ...halfDayTypeCountsToday.keys()]),
    );

    // We need leave type names – load only those we saw today
    let leaveTypeMap = new Map<string, { id: string; name: string }>();
    if (leaveTypeIdsToday.length > 0) {
      const { LeaveType } = require('../models/LeaveType');
      const typeRows = await LeaveType.query()
        .alias('lt')
        .where('lt.org_id', org_id)
        .whereIn('lt.id', leaveTypeIdsToday)
        .select('lt.id', 'lt.name');
      leaveTypeMap = new Map(typeRows.map((t: any) => [t.id, { id: t.id, name: t.name }]));
    }

    const onLeaveByTypeToday: Array<{
      id: string;
      name: string;
      count: number;
      percentage: number;
    }> = [];
    for (const [typeId, count] of leaveTypeCountsToday.entries()) {
      const totalOnLeave = todayInfo.onLeaveCount || 1;
      const typeMeta = leaveTypeMap.get(typeId);
      onLeaveByTypeToday.push({
        id: typeId,
        name: typeMeta?.name ?? 'Other',
        count,
        percentage: Math.round((count / totalOnLeave) * 100 * 100) / 100,
      });
    }

    const onHalfDayByTypeToday: Array<{
      id: string;
      name: string;
      count: number;
      percentage: number;
    }> = [];
    for (const [typeId, count] of halfDayTypeCountsToday.entries()) {
      const totalOnHalfDay = todayInfo.onHalfDayCount || 1;
      const typeMeta = leaveTypeMap.get(typeId);
      onHalfDayByTypeToday.push({
        id: typeId,
        name: typeMeta?.name ?? 'Other',
        count,
        percentage: Math.round((count / totalOnHalfDay) * 100 * 100) / 100,
      });
    }

    // Build overview by month (stacked percentages)
    const byMonth: Array<{
      month: number;
      year: number;
      present_count: number;
      on_leave_count: number;
      on_halfday_count: number;
      absent_count: number;
      present_percentage: number;
      on_leave_percentage: number;
      on_halfday_percentage: number;
      absent_percentage: number;
    }> = [];

    const cursorMonth = new Date(overviewStart);
    while (cursorMonth <= overviewEnd) {
      const year = cursorMonth.getFullYear();
      const month = cursorMonth.getMonth(); // 0-based

      const monthStart = new Date(year, month, 1);
      const monthEnd = new Date(year, month + 1, 0);

      let presentSum = 0;
      let onLeaveSum = 0;
      let onHalfDaySum = 0;
      let absentSum = 0;
      let scheduledUserDaysSum = 0;

      const dayCursor = new Date(monthStart);
      while (dayCursor <= monthEnd) {
        const dateKey = formatDateLocal(dayCursor);
        // Only count days within the exact overview range
        if (dateKey >= overviewStartStr && dateKey <= overviewEndStr) {
          const info = classifyForDate(dateKey);
          presentSum += info.presentCount;
          onLeaveSum += info.onLeaveCount;
          onHalfDaySum += info.onHalfDayCount;
          absentSum += info.absentCount;
          scheduledUserDaysSum += info.scheduledCount;
        }
        dayCursor.setDate(dayCursor.getDate() + 1);
      }

      const denom = Math.max(1, scheduledUserDaysSum);
      const presentPct = (presentSum / denom) * 100;
      const onLeavePct = (onLeaveSum / denom) * 100;
      const onHalfDayPct = (onHalfDaySum / denom) * 100;
      const absentPct = (absentSum / denom) * 100;

      byMonth.push({
        month: month + 1,
        year,
        present_count: presentSum,
        on_leave_count: onLeaveSum,
        on_halfday_count: onHalfDaySum,
        absent_count: absentSum,
        present_percentage: Math.round(presentPct * 100) / 100,
        on_leave_percentage: Math.round(onLeavePct * 100) / 100,
        on_halfday_percentage: Math.round(onHalfDayPct * 100) / 100,
        absent_percentage: Math.round(absentPct * 100) / 100,
      });

      cursorMonth.setMonth(cursorMonth.getMonth() + 1);
      cursorMonth.setDate(1);
    }

    return res.json({
      date: focusDateStr,
      months,
      summary_today: {
        total_employees: totalEmployees,
        present: {
          count: todayInfo.presentCount,
          change_vs_yesterday: todayInfo.presentCount - yesterdayInfo.presentCount,
          on_time: onTimeCount,
          late: lateCount,
          half_day_worked_count: todayInfo.halfDayWorkedCount,
        },
        on_leave: {
          count: todayInfo.onLeaveCount,
          change_vs_yesterday: todayInfo.onLeaveCount - yesterdayInfo.onLeaveCount,
          by_type: onLeaveByTypeToday,
        },
        on_halfday: {
          count: todayInfo.onHalfDayCount,
          change_vs_yesterday: todayInfo.onHalfDayCount - yesterdayInfo.onHalfDayCount,
          by_type: onHalfDayByTypeToday,
        },
        absent: {
          count: todayInfo.absentCount,
          change_vs_yesterday: todayInfo.absentCount - yesterdayInfo.absentCount,
        },
      },
      overview: {
        period: {
          start_date: overviewStartStr,
          end_date: overviewEndStr,
        },
        by_month: byMonth,
      },
    });
  }

  // Manager/HR - employee attendance table
  static async getManagerTeamAttendance(req: Request, res: Response): Promise<Response> {
    const reqWithManagerScope = req as Request & {
      __attendanceManagerScope?: boolean;
      __attendanceIncludeTeamMetrics?: boolean;
    };
    // Only restrict to managed departments when the caller is actually a manager.
    if (req.user?.role === 'manager') {
      reqWithManagerScope.__attendanceManagerScope = true;
    }
    reqWithManagerScope.__attendanceIncludeTeamMetrics = true;
    return AttendanceController.getOrgEmployeeAttendance(reqWithManagerScope, res);
  }

  // Admin/HR/Manager - employee attendance table
  static async getOrgEmployeeAttendance(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = attendanceOrgEmployeeListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const {
      date,
      from_date,
      to_date,
      page,
      limit,
      department_id,
      department,
      work_model,
      status,
      leave_session,
      search,
      sort_by,
      sort_dir,
    } = parsed.data;
    const isSortByProvided = Object.prototype.hasOwnProperty.call(req.query, 'sort_by');
    const filterDepartmentId = department || department_id;

    const org_id = req.user.org_id;
    const internalReq = req as Request & {
      __attendanceManagerScope?: boolean;
      __attendanceIncludeTeamMetrics?: boolean;
    };
    const forceManagerScope = internalReq.__attendanceManagerScope === true;
    const includeTeamMetrics = internalReq.__attendanceIncludeTeamMetrics === true;
    const todayStr = getTodayDate();
    const isDateMode = Boolean(date);
    const isRangeMode = Boolean(from_date && to_date);
    const isHistoryMode = !isDateMode && !isRangeMode;
    const isManager = forceManagerScope || req.user.role === 'manager';
    let managedDepartmentIds: string[] = [];
    if (isManager) {
      managedDepartmentIds = await getManagedDepartmentIds(org_id, req.user.id);
    }
    let teamMetrics: { total_employees: number; new_employees_this_month: number } | null = null;
    if (includeTeamMetrics) {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      const monthStartStr = formatDateLocal(monthStart);
      const monthEndStr = formatDateLocal(monthEnd);

      // For managers, compute metrics for their team only.
      // For HR (and other non-manager roles), compute org-wide metrics.
      // Include all attendance-scoped org roles (employee, hr, manager).
      const baseQuery = User.query()
        .alias('u')
        .where('u.org_id', org_id)
        .whereIn('u.role', ORG_USER_ROLES)
        .whereIn('u.status', ATTENDANCE_ACTIVE_EMPLOYEE_STATUSES as readonly string[])
        .whereNull('u.deleted_at');

      if (isManager) {
        if (managedDepartmentIds.length === 0) {
          baseQuery.whereRaw('1 = 0');
        } else {
          const managerSubquery = DepartmentManager.query()
            .alias('dm')
            .whereIn('dm.department_id', managedDepartmentIds)
            .select('dm.manager_id');

          baseQuery.where((b) => {
            b.whereIn('u.department_id', managedDepartmentIds).orWhereIn('u.id', managerSubquery);
          });
        }
      }

      const [teamTotalRow, newEmployeesRow] = await Promise.all([
        baseQuery.clone().countDistinct('u.id as count').first(),
        baseQuery
          .clone()
          .whereRaw(
            'COALESCE(u.date_of_joining::date, u.created_at::date) BETWEEN ?::date AND ?::date',
            [monthStartStr, monthEndStr],
          )
          .countDistinct('u.id as count')
          .first(),
      ]);

      teamMetrics = {
        total_employees: Number(
          (teamTotalRow as { count?: string | number } | undefined)?.count ?? 0,
        ),
        new_employees_this_month: Number(
          (newEmployeesRow as { count?: string | number } | undefined)?.count ?? 0,
        ),
      };
    }

    // Base attendance query (employee/hr/manager only, active, not soft-deleted)
    const baseQuery = User.query()
      .alias('u')
      .leftJoin('departments as d', 'd.id', 'u.department_id')
      .leftJoin('employee_employment_details as eed', 'eed.user_id', 'u.id')
      .leftJoin('work_shifts as ws_user', 'ws_user.id', 'u.shift_id')
      .leftJoin('work_shifts as ws_dept', 'ws_dept.id', 'd.default_shift_id')
      .where('u.org_id', org_id)
      .whereIn('u.role', ORG_USER_ROLES) // Include employee, hr, manager (exclude admin)
      .whereIn('u.status', ATTENDANCE_ACTIVE_EMPLOYEE_STATUSES as readonly string[])
      .whereNull('u.deleted_at')
      .modify((qb) => {
        // For managers, restrict to their managed departments only:
        // - include employees/HR directly in managed departments
        // - include managers assigned to those departments via department_managers
        if (isManager) {
          if (managedDepartmentIds.length === 0) {
            qb.whereRaw('1 = 0');
            return;
          }

          const managerSubquery = DepartmentManager.query()
            .alias('dm')
            .whereIn('dm.department_id', managedDepartmentIds)
            .select('dm.manager_id');

          qb.where((b) => {
            b.whereIn('u.department_id', managedDepartmentIds).orWhereIn('u.id', managerSubquery);
          });
        }
      })
      .modify((qb) => {
        if (isDateMode) {
          const dateStr = date as string;
          if (dateStr > todayStr) {
            qb.whereRaw('1 = 0');
            return;
          }
          qb.whereRaw('COALESCE(u.date_of_joining::date, u.created_at::date) <= ?::date', [
            dateStr,
          ]);
          return;
        }

        if (isRangeMode) {
          const fromDateStr = from_date as string;
          const toDateStr = to_date as string;
          const cappedToDateStr = toDateStr < todayStr ? toDateStr : todayStr;
          if (fromDateStr > todayStr) {
            qb.whereRaw('1 = 0');
            return;
          }
          qb.whereRaw('COALESCE(u.date_of_joining::date, u.created_at::date) <= ?::date', [
            cappedToDateStr,
          ]);
          return;
        }

        // Default mode should only include users already joined by today.
        qb.whereRaw('COALESCE(u.date_of_joining::date, u.created_at::date) <= ?::date', [todayStr]);
      });

    if (filterDepartmentId) {
      const managersInDeptSubquery = DepartmentManager.query()
        .alias('dm')
        .where('dm.department_id', filterDepartmentId)
        .select('dm.manager_id');
      baseQuery.where((b) => {
        b.where('u.department_id', filterDepartmentId).orWhereIn('u.id', managersInDeptSubquery);
      });
    }

    if (work_model) {
      baseQuery.where('eed.work_mode', work_model);
    }

    if (search) {
      const term = `%${search}%`;
      baseQuery.where((qb) => {
        qb.where('u.employee_id', 'ilike', term)
          .orWhere('u.first_name', 'ilike', term)
          .orWhere('u.last_name', 'ilike', term)
          .orWhere('u.official_email', 'ilike', term)
          .orWhere('d.name', 'ilike', term);
      });
    }

    // Sorting
    if (sort_by === 'STATUS') {
      // We sort later in memory once status is computed; for now use name ordering
      baseQuery.orderBy(['u.first_name', 'u.last_name']);
    } else if (sort_by === 'DATE') {
      baseQuery.orderBy('u.created_at', sort_dir === 'DESC' ? 'desc' : 'asc');
    } else {
      baseQuery.orderBy([
        { column: 'u.first_name', order: sort_dir === 'DESC' ? 'desc' : 'asc' },
        { column: 'u.last_name', order: sort_dir === 'DESC' ? 'desc' : 'asc' },
      ]);
    }

    const employeeRows = await baseQuery
      .clone()
      .select(
        'u.id',
        'u.employee_id',
        'u.first_name',
        'u.last_name',
        'u.profile_image_url',
        'u.date_of_joining',
        'u.created_at',
        'u.designation',
        'u.role',
        'd.id as department_id',
        'd.name as department_name',
        'd.working_days as department_working_days',
        'eed.work_mode',
        'eed.employment_type',
        'ws_user.start_time as user_shift_start_time',
        'ws_user.end_time as user_shift_end_time',
        'ws_user.break_start_time as user_shift_break_start_time',
        'ws_user.break_end_time as user_shift_break_end_time',
        'ws_user.break_duration_mins as user_shift_break_duration_mins',
        'ws_dept.start_time as dept_shift_start_time',
        'ws_dept.end_time as dept_shift_end_time',
        'ws_dept.break_start_time as dept_shift_break_start_time',
        'ws_dept.break_end_time as dept_shift_break_end_time',
        'ws_dept.break_duration_mins as dept_shift_break_duration_mins',
      );

    // Build department arrays for manager users (consistent with /api/users)
    const managerUserIds = (employeeRows as any[])
      .filter((row: any) => row.role === 'manager')
      .map((row: any) => String(row.id));

    const managerDepartmentsMap = await getManagedDepartmentSummaries(org_id, managerUserIds);

    const departmentIdsForShifts = new Set<string>();
    for (const row of employeeRows as any[]) {
      if (row.department_id) {
        departmentIdsForShifts.add(String(row.department_id));
      }
    }
    for (const departments of managerDepartmentsMap.values()) {
      for (const department of departments) {
        departmentIdsForShifts.add(String(department.id));
      }
    }
    const workShiftsByDepartmentId = await fetchWorkShiftsByDepartmentIds(
      org_id,
      Array.from(departmentIdsForShifts),
    );

    const listManagerIdsNeedingScheduleFallback = (employeeRows as any[])
      .filter(
        (r: any) =>
          r.role === 'manager' &&
          !(
            r.department_id &&
            Array.isArray(r.department_working_days) &&
            r.department_working_days.length > 0
          ),
      )
      .map((r: any) => String(r.id));
    const listManagedScheduleByManagerId = await fetchPrimaryManagedDepartmentScheduleByManagerIds(
      org_id,
      listManagerIdsNeedingScheduleFallback,
    );
    const effectiveAttendanceScheduleByUserId = new Map<
      string,
      { departmentId: string | null; workingDays: string[] | null }
    >();
    for (const r of employeeRows as any[]) {
      const eff = resolveEffectiveAttendanceSchedule(
        {
          role: r.role,
          department_id: r.department_id ?? null,
          department_working_days: r.department_working_days,
        },
        listManagedScheduleByManagerId.get(String(r.id)),
      );
      effectiveAttendanceScheduleByUserId.set(String(r.id), eff);
    }

    const employeeIds = employeeRows.map((r: any) => r.id);

    if (employeeIds.length === 0) {
      if (includeTeamMetrics) {
        return res.json({
          page: 1,
          limit,
          total: 0,
          total_pages: 1,
          date: date ?? null,
          from_date: from_date ?? null,
          to_date: to_date ?? null,
          card_summary: {
            total_employees: teamMetrics?.total_employees ?? 0,
            new_employees_this_month: teamMetrics?.new_employees_this_month ?? 0,
          },
          items: [],
        });
      }

      return res.json({
        page: 1,
        limit,
        total: 0,
        total_pages: 1,
        date: date ?? null,
        from_date: from_date ?? null,
        to_date: to_date ?? null,
        data: [],
      });
    }

    const employeeJoinDates = employeeRows
      .map((row: any) => normalizeDate(row.date_of_joining ?? row.created_at ?? null))
      .filter((value): value is string => Boolean(value));
    const historyFromDate =
      employeeJoinDates.length > 0
        ? employeeJoinDates.reduce((minDate, currentDate) =>
            currentDate < minDate ? currentDate : minDate,
          )
        : todayStr;

    let listHolidayStart = todayStr;
    let listHolidayEnd = todayStr;
    if (isDateMode && date) {
      listHolidayStart = date as string;
      listHolidayEnd = date as string;
    } else if (isRangeMode || isHistoryMode) {
      const rangeFrom = isRangeMode ? (from_date as string) : historyFromDate;
      const rangeTo = isRangeMode ? (to_date as string) : todayStr;
      const rangeToCappedForHol = rangeTo < todayStr ? rangeTo : todayStr;
      listHolidayStart = rangeFrom;
      listHolidayEnd = rangeToCappedForHol;
    }
    const listHolidaySetByUserId = await fetchEffectiveHolidayDateSetsForUsers(
      org_id,
      employeeIds.map(String),
      listHolidayStart,
      listHolidayEnd,
    );
    const listHolidaySet = await fetchOrgHolidayDateSet(org_id, listHolidayStart, listHolidayEnd);

    // Attendance logs: either for a specific date or day-wise within an explicit/implicit range
    let logsByUserId = new Map<string, AttendanceLog>();
    let logsByUserDate = new Map<string, AttendanceLog>();
    if (isDateMode && (date as string) <= todayStr) {
      const dateStr = date as string;
      const logRows = await AttendanceLog.query()
        .alias('al')
        .where('al.org_id', org_id)
        .where('date', dateStr)
        .whereIn('al.user_id', employeeIds)
        .select(
          'al.id',
          'al.user_id',
          'al.clock_in_time',
          'al.clock_out_time',
          'al.punch_in_lat',
          'al.punch_in_long',
          'al.punch_out_lat',
          'al.punch_out_long',
          'al.total_work_hours',
          'al.overtime_minutes',
        );

      logsByUserId = new Map<string, AttendanceLog>();
      for (const log of logRows as any[]) {
        logsByUserId.set(log.user_id, log);
      }
    } else if (isRangeMode || isHistoryMode) {
      const rangeFrom = isRangeMode ? (from_date as string) : historyFromDate;
      const rangeTo = isRangeMode ? (to_date as string) : todayStr;
      const rangeToCapped = rangeTo < todayStr ? rangeTo : todayStr;

      if (rangeToCapped < rangeFrom) {
        logsByUserId = new Map<string, AttendanceLog>();
        logsByUserDate = new Map<string, AttendanceLog>();
      } else {
        const rangeLogRows = await AttendanceLog.query()
          .alias('al')
          .where('al.org_id', org_id)
          .whereBetween('date', [rangeFrom, rangeToCapped])
          .whereIn('al.user_id', employeeIds)
          .select(
            'al.id',
            'al.user_id',
            'al.date',
            'al.clock_in_time',
            'al.clock_out_time',
            'al.punch_in_lat',
            'al.punch_in_long',
            'al.punch_out_lat',
            'al.punch_out_long',
            'al.total_work_hours',
            'al.overtime_minutes',
          )
          .orderBy([
            { column: 'al.user_id', order: 'asc' },
            { column: 'al.date', order: 'asc' },
            { column: 'al.clock_in_time', order: 'desc' },
          ]);

        logsByUserDate = new Map<string, AttendanceLog>();
        for (const log of rangeLogRows as any[]) {
          const logDateStr = normalizeDate(log.date);
          if (!logDateStr) continue;
          const key = `${log.user_id}|${logDateStr}`;
          if (!logsByUserDate.has(key)) {
            logsByUserDate.set(key, log);
          }
        }
      }
    }

    // Fetch breaks for all logs
    const logsForBreaks =
      isRangeMode || isHistoryMode
        ? Array.from(logsByUserDate.values())
        : Array.from(logsByUserId.values());
    const logIds = logsForBreaks.map((l: any) => l.id);
    const breakRows =
      logIds.length > 0
        ? await AttendanceBreak.query()
            .whereIn('attendance_log_id', logIds)
            .select('attendance_log_id', 'start_time', 'end_time')
        : [];

    // Use number keys to match log.id type (attendance_log_id is a number)
    const breaksByLogId = new Map<
      number,
      Array<{ start_time: string; end_time?: string | null }>
    >();
    for (const brk of breakRows as any[]) {
      const logId = Number(brk.attendance_log_id);
      if (!breaksByLogId.has(logId)) {
        breaksByLogId.set(logId, []);
      }
      breaksByLogId.get(logId)!.push({
        start_time: brk.start_time,
        end_time: brk.end_time,
      });
    }

    // Leave requests for status calculation:
    // - specific date mode: leave overlapping that date
    // - range mode: leave overlapping any day in range
    let leaveUserIds = new Set<string>();
    const leaveSessionByUserId = new Map<string, LeaveDaySession>();
    let leaveRangesByUserId = new Map<
      string,
      Array<{ start_date: string; end_date: string; status: string; day_session: LeaveDaySession }>
    >();
    if (isDateMode && (date as string) <= todayStr) {
      const dateStr = date as string;
      const leaveRows = await LeaveRequest.query()
        .alias('lr')
        .where('lr.org_id', org_id)
        .whereIn('lr.user_id', employeeIds)
        .where('lr.status', 'APPROVED')
        .where('start_date', '<=', dateStr)
        .where('end_date', '>=', dateStr)
        .select('lr.user_id', 'lr.day_session');

      for (const r of leaveRows as any[]) {
        leaveSessionByUserId.set(
          String(r.user_id),
          mergeLeaveDaySessions(leaveSessionByUserId.get(String(r.user_id)), r.day_session),
        );
      }
      leaveUserIds = new Set<string>(
        [...leaveSessionByUserId.entries()]
          .filter(([, session]) => session === 'FULL')
          .map(([userId]) => userId),
      );
    } else if (isRangeMode || isHistoryMode) {
      const rangeFrom = isRangeMode ? (from_date as string) : historyFromDate;
      const rangeTo = isRangeMode ? (to_date as string) : todayStr;
      const rangeToCapped = rangeTo < todayStr ? rangeTo : todayStr;

      if (rangeToCapped >= rangeFrom) {
        const leaveRows = await LeaveRequest.query()
          .alias('lr')
          .where('lr.org_id', org_id)
          .whereIn('lr.user_id', employeeIds)
          .where('lr.status', 'APPROVED')
          .where((qb) => {
            qb.whereBetween('start_date', [rangeFrom, rangeToCapped])
              .orWhereBetween('end_date', [rangeFrom, rangeToCapped])
              .orWhere((inner) =>
                inner.where('start_date', '<=', rangeFrom).where('end_date', '>=', rangeToCapped),
              );
          })
          .select('lr.user_id', 'lr.start_date', 'lr.end_date', 'lr.status', 'lr.day_session');

        leaveRangesByUserId = new Map<
          string,
          Array<{
            start_date: string;
            end_date: string;
            status: string;
            day_session: LeaveDaySession;
          }>
        >();
        for (const leave of leaveRows as any[]) {
          if (!leaveRangesByUserId.has(leave.user_id)) {
            leaveRangesByUserId.set(leave.user_id, []);
          }
          // Normalize dates to YYYY-MM-DD format for consistent comparison
          const normalizedStartDate = normalizeDate(leave.start_date);
          const normalizedEndDate = normalizeDate(leave.end_date);
          leaveRangesByUserId.get(leave.user_id)!.push({
            start_date: normalizedStartDate,
            end_date: normalizedEndDate,
            status: leave.status,
            day_session: (leave.day_session ?? 'FULL') as LeaveDaySession,
          });
        }
      }
    }

    // Approved WFH for status calculation (parallel to leave)
    let wfhUserIds = new Set<string>();
    let wfhRangesByUserId = new Map<string, Array<{ start_date: string; end_date: string }>>();
    if (isDateMode && (date as string) <= todayStr) {
      const dateStr = date as string;
      const wfhRows = await WfhRequest.query()
        .alias('wr')
        .where('wr.org_id', org_id)
        .whereIn('wr.user_id', employeeIds)
        .where('wr.status', 'APPROVED')
        .where('start_date', '<=', dateStr)
        .where('end_date', '>=', dateStr)
        .select('wr.user_id');
      wfhUserIds = new Set<string>((wfhRows as any[]).map((r) => String(r.user_id)));
    } else if (isRangeMode || isHistoryMode) {
      const rangeFrom = isRangeMode ? (from_date as string) : historyFromDate;
      const rangeTo = isRangeMode ? (to_date as string) : todayStr;
      const rangeToCapped = rangeTo < todayStr ? rangeTo : todayStr;

      if (rangeToCapped >= rangeFrom) {
        const wfhRows = await WfhRequest.query()
          .alias('wr')
          .where('wr.org_id', org_id)
          .whereIn('wr.user_id', employeeIds)
          .where('wr.status', 'APPROVED')
          .where((qb) => {
            qb.whereBetween('start_date', [rangeFrom, rangeToCapped])
              .orWhereBetween('end_date', [rangeFrom, rangeToCapped])
              .orWhere((inner) =>
                inner.where('start_date', '<=', rangeFrom).where('end_date', '>=', rangeToCapped),
              );
          })
          .select('wr.user_id', 'wr.start_date', 'wr.end_date');

        wfhRangesByUserId = new Map();
        for (const wfh of wfhRows as any[]) {
          if (!wfhRangesByUserId.has(wfh.user_id)) {
            wfhRangesByUserId.set(wfh.user_id, []);
          }
          wfhRangesByUserId.get(wfh.user_id)!.push({
            start_date: normalizeDate(wfh.start_date),
            end_date: normalizeDate(wfh.end_date),
          });
        }
      }
    }

    // Approved attendance correction/regularization requests that affect clock-out,
    // used to derive clock_out_type = "regularized".
    const regularizedClockOutByUserDate = new Map<string, boolean>();
    if (isDateMode && (date as string) <= todayStr) {
      const dateStr = date as string;
      const correctionRows = await AttendanceCorrectionRequest.query()
        .alias('acr')
        .whereIn('acr.user_id', employeeIds)
        .where('acr.request_date', dateStr)
        .where('acr.status', 'APPROVED')
        .where((qb) => {
          qb.whereNotNull('acr.requested_clock_out').orWhereIn('acr.wrong_punch_type', [
            'CLOCK_OUT',
            'MISSING_OUT',
            'WRONG_OUT',
          ]);
        })
        .select('acr.user_id', 'acr.request_date');

      for (const row of correctionRows as any[]) {
        const key = `${row.user_id}|${row.request_date}`;
        regularizedClockOutByUserDate.set(key, true);
      }
    } else if (isRangeMode || isHistoryMode) {
      const rangeFrom = isRangeMode ? (from_date as string) : historyFromDate;
      const rangeTo = isRangeMode ? (to_date as string) : todayStr;
      const rangeToCapped = rangeTo < todayStr ? rangeTo : todayStr;

      if (rangeToCapped >= rangeFrom) {
        const correctionRows = await AttendanceCorrectionRequest.query()
          .alias('acr')
          .whereIn('acr.user_id', employeeIds)
          .whereBetween('acr.request_date', [rangeFrom, rangeToCapped])
          .where('acr.status', 'APPROVED')
          .where((qb) => {
            qb.whereNotNull('acr.requested_clock_out').orWhereIn('acr.wrong_punch_type', [
              'CLOCK_OUT',
              'MISSING_OUT',
              'WRONG_OUT',
            ]);
          })
          .select('acr.user_id', 'acr.request_date');

        for (const row of correctionRows as any[]) {
          const key = `${row.user_id}|${row.request_date}`;
          regularizedClockOutByUserDate.set(key, true);
        }
      }
    }

    const pendingCorrectionByUserDate = new Set<string>();
    if (employeeIds.length > 0) {
      const pendingRows = await AttendanceCorrectionRequest.query()
        .alias('acr')
        .whereIn('acr.user_id', employeeIds)
        .where('acr.status', 'PENDING')
        .whereBetween('acr.request_date', [listHolidayStart, listHolidayEnd])
        .select('acr.user_id', 'acr.request_date');
      for (const row of pendingRows as any[]) {
        const d = normalizeDate(row.request_date) || String(row.request_date).slice(0, 10);
        pendingCorrectionByUserDate.add(`${row.user_id}|${d}`);
      }
    }

    const items: Array<{
      employee: {
        id: string;
        employee_id: string;
        full_name: string;
        role: string;
        designation: string | null;
        department: { id: string; name: string } | Array<{ id: string; name: string }> | null;
        work_model: string | null;
        employment_type: string | null;
        profile_image_url: string | null;
        work_shifts: WorkShiftSummary[];
      };
      date: string | null;
      clock_in_time: string | null;
      clock_in_latitude: number | null;
      clock_in_longitude: number | null;
      clock_out_time: string | null;
      clock_out_latitude: number | null;
      clock_out_longitude: number | null;
      clock_out_type: ClockOutType | null;
      duration_seconds: number | null;
      total_break_seconds: number;
      overtime_seconds: number;
      status: AdminAttendanceStatus;
      leave_session?: LeaveDaySession | null;
      session_window?: LeaveSessionWindow | null;
      is_on_halfday_leave: boolean;
      is_wfh?: boolean;
      late_by_minutes: number;
    }> = [];

    const lateGracePeriodMins = await getOrgLateGracePeriodMins(org_id);
    const otRoundOff = await getOrgOtRoundOffSettings(org_id);
    const shiftByUserId = await resolveLeaveSessionWindowsForUsers(org_id, employeeIds);

    for (const row of employeeRows as any[]) {
      const log = logsByUserId.get(row.id);
      const resolvedJoinDate = row.date_of_joining ?? row.created_at ?? null;
      const joinDateNormalized = normalizeDate(resolvedJoinDate);
      const joinDateStr = joinDateNormalized || null;
      const isFutureDate = isDateMode ? (date as string) > todayStr : false;
      const isBeforeJoiningDate =
        isDateMode && joinDateStr ? (date as string) < joinDateStr : false;
      const rangeFrom = from_date as string | undefined;
      const rangeTo = to_date as string | undefined;
      const isFutureRange = isRangeMode ? (rangeFrom as string) > todayStr : false;
      const isBeforeJoiningRange =
        isRangeMode && joinDateStr ? (rangeTo as string) < joinDateStr : false;
      const suppressAttendanceData =
        (isDateMode && (isFutureDate || isBeforeJoiningDate)) ||
        (isRangeMode && (isFutureRange || isBeforeJoiningRange));

      let shift_start_time = row.user_shift_start_time ?? row.dept_shift_start_time ?? null;
      let shift_end_time = row.user_shift_end_time ?? row.dept_shift_end_time ?? null;
      let shift_break_start =
        row.user_shift_break_start_time ?? row.dept_shift_break_start_time ?? null;
      let shift_break_end = row.user_shift_break_end_time ?? row.dept_shift_break_end_time ?? null;
      let shift_break_duration_mins: number | null =
        row.user_shift_break_duration_mins != null
          ? Number(row.user_shift_break_duration_mins)
          : row.dept_shift_break_duration_mins != null
            ? Number(row.dept_shift_break_duration_mins)
            : null;

      // For managers, if no shift is configured directly or via department,
      // fall back to the default shift from their managed departments (same
      // behavior as resolveShift-based APIs like /dashboard-status).
      if (
        row.role === 'manager' &&
        (!shift_start_time || parseTimeToMinutes(shift_start_time) === 0) &&
        (!shift_end_time || parseTimeToMinutes(shift_end_time) === 0)
      ) {
        const resolvedShift = await resolveShift(org_id, row.id);
        if (resolvedShift) {
          if (!shift_start_time) {
            shift_start_time = resolvedShift.start_time ?? shift_start_time;
          }
          if (!shift_end_time) {
            shift_end_time = resolvedShift.end_time ?? shift_end_time;
          }
          if (!shift_break_start) {
            shift_break_start = resolvedShift.break_start_time ?? shift_break_start;
          }
          if (!shift_break_end) {
            shift_break_end = resolvedShift.break_end_time ?? shift_break_end;
          }
          if (shift_break_duration_mins == null || shift_break_duration_mins === 0) {
            const rd = resolvedShift.break_duration_mins;
            shift_break_duration_mins =
              rd != null && Number(rd) > 0 ? Number(rd) : shift_break_duration_mins;
          }
        }
      }

      const shiftBreakForOvertimeRow = {
        break_start_time: shift_break_start,
        break_end_time: shift_break_end,
        break_duration_mins: shift_break_duration_mins,
      };

      // Build department array for manager employees
      let departmentValue:
        | { id: string; name: string }
        | Array<{ id: string; name: string }>
        | null = null;
      if (row.role === 'manager') {
        const fromMap = managerDepartmentsMap.get(String(row.id)) ?? [];
        const uniqueDepartments: Array<{ id: string; name: string }> = [];
        const seen = new Set<string>();

        for (const d of fromMap) {
          const deptId = String(d.id);
          if (seen.has(deptId)) continue;
          seen.add(deptId);
          uniqueDepartments.push({
            id: deptId,
            name: String(d.name),
          });
        }

        if (row.department_id && row.department_name) {
          const deptIdStr = String(row.department_id);
          if (!seen.has(deptIdStr)) {
            uniqueDepartments.push({
              id: deptIdStr,
              name: String(row.department_name),
            });
          }
        }

        departmentValue = uniqueDepartments.length > 0 ? uniqueDepartments : null;
      } else if (row.department_id && row.department_name) {
        departmentValue = { id: row.department_id, name: row.department_name };
      } else {
        departmentValue = null;
      }

      const employeeDepartmentIdsForShifts: string[] = [];
      if (row.role === 'manager') {
        const seenDeptIds = new Set<string>();
        for (const department of managerDepartmentsMap.get(String(row.id)) ?? []) {
          const deptId = String(department.id);
          if (seenDeptIds.has(deptId)) continue;
          seenDeptIds.add(deptId);
          employeeDepartmentIdsForShifts.push(deptId);
        }
        if (row.department_id) {
          const deptIdStr = String(row.department_id);
          if (!seenDeptIds.has(deptIdStr)) {
            employeeDepartmentIdsForShifts.push(deptIdStr);
          }
        }
      } else if (row.department_id) {
        employeeDepartmentIdsForShifts.push(String(row.department_id));
      }
      const employeeWorkShifts = resolveEmployeeWorkShifts(
        employeeDepartmentIdsForShifts,
        workShiftsByDepartmentId,
      );

      if (isRangeMode || isHistoryMode) {
        const rangeFrom = isRangeMode ? (from_date as string) : historyFromDate;
        const rangeTo = isRangeMode ? (to_date as string) : todayStr;
        const rangeToCapped = rangeTo < todayStr ? rangeTo : todayStr;
        const effectiveStart = joinDateStr && joinDateStr > rangeFrom ? joinDateStr : rangeFrom;
        const effectiveEnd = rangeToCapped;

        if (effectiveEnd < effectiveStart) {
          continue;
        }

        const leaveRanges = leaveRangesByUserId.get(row.id) ?? [];
        const rangeCursor = new Date(`${effectiveStart}T00:00:00.000Z`);
        const rangeEndDate = new Date(`${effectiveEnd}T00:00:00.000Z`);

        while (rangeCursor <= rangeEndDate) {
          const day = formatDateLocal(rangeCursor);

          const dayLog = logsByUserDate.get(`${row.id}|${day}`) as any | undefined;
          const pendingKey = `${row.id}|${day}`;
          const effSchedRange = effectiveAttendanceScheduleByUserId.get(String(row.id));
          if (
            shouldOmitAttendanceCalendarDate({
              dateStr: day,
              holidaySet: listHolidaySetByUserId.get(String(row.id)) ?? listHolidaySet,
              departmentId: effSchedRange?.departmentId ?? null,
              workingDays: effSchedRange?.workingDays ?? null,
              hasLog: Boolean(dayLog),
              hasPendingCorrection: pendingCorrectionByUserDate.has(pendingKey),
            })
          ) {
            rangeCursor.setUTCDate(rangeCursor.getUTCDate() + 1);
            continue;
          }

          let dayStatus: AdminAttendanceStatus = 'ABSENT';
          let clockInFormatted: string | null = null;
          let clockOutFormatted: string | null = null;
          let durationSeconds: number | null = null;
          let totalBreakSeconds = 0;
          let overtimeSeconds = 0;
          let lateByMinutes = 0;
          let clockOutType: ClockOutType | null = null;

          const daySession = leaveRanges
            .filter((leave) => leave.start_date <= day && leave.end_date >= day)
            .reduce<
              LeaveDaySession | undefined
            >((merged, leave) => mergeLeaveDaySessions(merged, leave.day_session), undefined);
          const leaveDerivedStatus = resolveAdminAttendanceStatus({
            leaveSession: daySession,
            hasClockIn: Boolean(dayLog?.clock_in_time),
            evaluationDateStr: day,
            todayStr,
          });
          if (leaveDerivedStatus === 'LEAVE' || leaveDerivedStatus === 'HALF_DAY') {
            dayStatus = leaveDerivedStatus;
          } else if (dayLog) {
            clockInFormatted = formatTime(dayLog.clock_in_time);
            clockOutFormatted = formatTime(dayLog.clock_out_time);
            const breaks = breaksByLogId.get(Number(dayLog.id)) ?? [];
            const endTimeForBreaks = dayLog.clock_out_time
              ? new Date(dayLog.clock_out_time)
              : new Date();
            totalBreakSeconds = calculateBreakSeconds(breaks, endTimeForBreaks);
            durationSeconds = calculateWorkSeconds(
              dayLog.clock_in_time,
              dayLog.clock_out_time,
              breaks,
            );
            overtimeSeconds = getEffectiveOvertimeSeconds(
              dayLog,
              breaks,
              shift_start_time,
              shift_end_time,
              shiftBreakForOvertimeRow,
              {
                isAttendanceScheduledDay: isUserAttendanceScheduledDay({
                  dateStr: day,
                  holidaySet: listHolidaySetByUserId.get(String(row.id)) ?? listHolidaySet,
                  departmentId: effSchedRange?.departmentId ?? null,
                  workingDays: effSchedRange?.workingDays ?? null,
                }),
                otRoundOffEnabled: otRoundOff.enabled,
                otRoundOffMins: otRoundOff.mins,
              },
            );
            const lateInfo = calculateLateArrival(
              dayLog.clock_in_time,
              shift_start_time,
              lateGracePeriodMins,
            );
            lateByMinutes = lateInfo.lateByMinutes;
            dayStatus = lateInfo.isLate ? 'LATE' : 'ON_TIME';
            const isWfhDay = (wfhRangesByUserId.get(row.id) ?? []).some(
              (w) => w.start_date <= day && w.end_date >= day,
            );
            if (isWfhDay && dayStatus === 'ON_TIME') {
              dayStatus = 'WFH';
            }
            const regularizationKey = `${row.id}|${day}`;
            const hasRegularizedClockOut = regularizedClockOutByUserDate.has(regularizationKey);
            clockOutType = determineClockOutType(
              dayLog.clock_out_time,
              shift_end_time,
              hasRegularizedClockOut,
            );
          }

          const fullName = `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim();
          const isWfhDayItem = (wfhRangesByUserId.get(row.id) ?? []).some(
            (w) => w.start_date <= day && w.end_date >= day,
          );
          items.push({
            employee: {
              id: row.id,
              employee_id: row.employee_id,
              full_name: fullName,
              role: row.role,
              designation: row.designation ?? null,
              department: departmentValue,
              work_model: row.work_mode ?? null,
              employment_type: row.employment_type ?? null,
              profile_image_url: row.profile_image_url ?? null,
              work_shifts: employeeWorkShifts,
            },
            date: day,
            clock_in_time: clockInFormatted,
            clock_in_latitude: parseCoordinate(dayLog?.punch_in_lat),
            clock_in_longitude: parseCoordinate(dayLog?.punch_in_long),
            clock_out_time: clockOutFormatted,
            clock_out_latitude: parseCoordinate(dayLog?.punch_out_lat),
            clock_out_longitude: parseCoordinate(dayLog?.punch_out_long),
            clock_out_type: clockOutType,
            duration_seconds: durationSeconds,
            total_break_seconds: totalBreakSeconds,
            overtime_seconds: overtimeSeconds,
            status: dayStatus,
            leave_session: daySession ?? null,
            session_window: daySession
              ? sessionWindowForLeaveRow(shiftByUserId.get(String(row.id)) ?? null, daySession)
              : null,
            is_on_halfday_leave: isHalfDayLeaveSession(daySession),
            is_wfh: Boolean(isWfhDayItem && dayLog?.clock_in_time),
            late_by_minutes: lateByMinutes,
          });

          rangeCursor.setUTCDate(rangeCursor.getUTCDate() + 1);
        }

        continue;
      }

      let status: AdminAttendanceStatus = 'ABSENT';
      let clockInFormatted: string | null = null;
      let clockOutFormatted: string | null = null;
      let durationSeconds: number | null = null;
      let totalBreakSeconds = 0;
      let overtimeSeconds = 0;
      let lateByMinutes = 0;
      let clockOutType: ClockOutType | null = null;

      if (!suppressAttendanceData && isDateMode) {
        const userLeaveSession = leaveSessionByUserId.get(String(row.id));
        const evaluationDateStrForStatus = isDateMode
          ? (date as string)
          : isRangeMode
            ? (to_date as string)
            : todayStr;
        const leaveDerivedStatus = resolveAdminAttendanceStatus({
          leaveSession: userLeaveSession,
          hasClockIn: Boolean((log as any)?.clock_in_time),
          evaluationDateStr: evaluationDateStrForStatus,
          todayStr,
        });
        if (leaveDerivedStatus) {
          status = leaveDerivedStatus;
        }
      } else if (
        !suppressAttendanceData &&
        (isDateMode || isRangeMode) &&
        leaveUserIds.has(row.id)
      ) {
        status = 'LEAVE';
      }

      const evaluationDateStr = isDateMode
        ? (date as string)
        : isRangeMode
          ? (to_date as string)
          : todayStr;

      // Single-date list: omit off-days unless log or pending correction (range/history above).
      const effSchedDate = effectiveAttendanceScheduleByUserId.get(String(row.id));
      if (
        isDateMode &&
        shouldOmitAttendanceCalendarDate({
          dateStr: date as string,
          holidaySet: listHolidaySetByUserId.get(String(row.id)) ?? listHolidaySet,
          departmentId: effSchedDate?.departmentId ?? null,
          workingDays: effSchedDate?.workingDays ?? null,
          hasLog: Boolean(log),
          hasPendingCorrection: pendingCorrectionByUserDate.has(`${row.id}|${date as string}`),
        })
      ) {
        continue;
      }

      if (suppressAttendanceData) {
        continue;
      }

      if (log && status !== 'LEAVE' && status !== 'HALF_DAY') {
        clockInFormatted = formatTime((log as any).clock_in_time);
        clockOutFormatted = formatTime((log as any).clock_out_time);

        // Calculate duration from timestamps (exact calculation)
        // Use Number(log.id) to match the key format used in breaksByLogId
        const breaks = breaksByLogId.get(Number((log as any).id)) ?? [];

        // Use the same end time logic as other APIs for consistency
        const endTimeForBreaks = (log as any).clock_out_time
          ? new Date((log as any).clock_out_time)
          : new Date();

        // Calculate break seconds using the same helper as other APIs
        totalBreakSeconds = calculateBreakSeconds(breaks, endTimeForBreaks);

        // Use the same calculateWorkSeconds helper as dashboard-status and calendar APIs
        // This ensures consistent total_work_seconds/duration_seconds across all APIs
        durationSeconds = calculateWorkSeconds(
          (log as any).clock_in_time,
          (log as any).clock_out_time,
          breaks,
        );

        // Calculate overtime in seconds
        overtimeSeconds = getEffectiveOvertimeSeconds(
          log as AttendanceLog,
          breaks,
          shift_start_time,
          shift_end_time,
          shiftBreakForOvertimeRow,
          {
            isAttendanceScheduledDay: isUserAttendanceScheduledDay({
              dateStr: evaluationDateStr,
              holidaySet: listHolidaySetByUserId.get(String(row.id)) ?? listHolidaySet,
              departmentId: effSchedDate?.departmentId ?? null,
              workingDays: effSchedDate?.workingDays ?? null,
            }),
            otRoundOffEnabled: otRoundOff.enabled,
            otRoundOffMins: otRoundOff.mins,
          },
        );

        const lateInfo = calculateLateArrival(
          (log as any).clock_in_time,
          shift_start_time,
          lateGracePeriodMins,
        );
        lateByMinutes = lateInfo.lateByMinutes;
        status = lateInfo.isLate ? 'LATE' : 'ON_TIME';
        if (wfhUserIds.has(String(row.id)) && status === 'ON_TIME') {
          status = 'WFH';
        }
        const regularizationKey = `${row.id}|${evaluationDateStr}`;
        const hasRegularizedClockOut = regularizedClockOutByUserDate.has(regularizationKey);
        clockOutType = determineClockOutType(
          (log as any).clock_out_time,
          shift_end_time,
          hasRegularizedClockOut,
        );
      } else if (status !== 'LEAVE' && status !== 'HALF_DAY') {
        const pendingKeySingle = `${row.id}|${evaluationDateStr}`;
        // Admin users list: treat no clock-in log as ABSENT immediately.
        // This keeps the users table consistent with the dashboard absent logic.
        void pendingKeySingle;
        status = 'ABSENT';
      }

      const fullName = `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim();

      items.push({
        employee: {
          id: row.id,
          employee_id: row.employee_id,
          full_name: fullName,
          role: row.role,
          designation: row.designation ?? null,
          department: row.department_id
            ? { id: row.department_id, name: row.department_name }
            : null,
          work_model: row.work_mode ?? null,
          employment_type: row.employment_type ?? null,
          profile_image_url: row.profile_image_url ?? null,
          work_shifts: employeeWorkShifts,
        },
        date: date ?? (log ? normalizeDate((log as any).date) : null),
        clock_in_time: clockInFormatted,
        clock_in_latitude: parseCoordinate((log as any)?.punch_in_lat),
        clock_in_longitude: parseCoordinate((log as any)?.punch_in_long),
        clock_out_time: clockOutFormatted,
        clock_out_latitude: parseCoordinate((log as any)?.punch_out_lat),
        clock_out_longitude: parseCoordinate((log as any)?.punch_out_long),
        clock_out_type: clockOutType,
        duration_seconds: durationSeconds,
        total_break_seconds: totalBreakSeconds,
        overtime_seconds: overtimeSeconds,
        status,
        leave_session: leaveSessionByUserId.get(String(row.id)) ?? null,
        session_window: sessionWindowForLeaveRow(
          shiftByUserId.get(String(row.id)) ?? null,
          leaveSessionByUserId.get(String(row.id)),
        ),
        is_on_halfday_leave: isHalfDayLeaveSession(leaveSessionByUserId.get(String(row.id))),
        is_wfh: Boolean(wfhUserIds.has(String(row.id)) && (log as any)?.clock_in_time),
        late_by_minutes: lateByMinutes,
      });
    }

    // Optional status filter on computed items
    const visibleStatuses = new Set<AdminAttendanceStatus>(ADMIN_VISIBLE_ATTENDANCE_STATUSES);
    let filteredItems = items.filter((i) => visibleStatuses.has(i.status));
    if (status && status !== 'ALL') {
      filteredItems = filteredItems.filter((i) => i.status === status);
    }
    if (leave_session) {
      if (leave_session === 'ANY_HALF') {
        filteredItems = filteredItems.filter((i) => isHalfDayLeaveSession(i.leave_session));
      } else {
        filteredItems = filteredItems.filter((i) => i.leave_session === leave_session);
      }
    }

    // If front-end requested sorting by STATUS, sort now
    if (sort_by === 'STATUS') {
      const dir = sort_dir === 'DESC' ? -1 : 1;
      const order = ADMIN_ATTENDANCE_STATUS_SORT_ORDER;
      const indexOf = (s: AdminAttendanceStatus) => order.indexOf(s);
      filteredItems.sort((a, b) => (indexOf(a.status) - indexOf(b.status)) * dir);
    } else if (sort_by === 'DATE' || !isSortByProvided) {
      // Default behavior (when sort_by is omitted) is latest attendance date first.
      const dir = isSortByProvided ? (sort_dir === 'DESC' ? -1 : 1) : -1;
      filteredItems.sort((a, b) => {
        const dateA = a.date ?? '';
        const dateB = b.date ?? '';
        if (!dateA && !dateB) return 0;
        if (!dateA) return 1;
        if (!dateB) return -1;
        const dateCompare = dateA.localeCompare(dateB);
        if (dateCompare !== 0) {
          return dateCompare * dir;
        }
        return a.employee.full_name.localeCompare(b.employee.full_name);
      });
    }

    const total = filteredItems.length;
    const total_pages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(Math.max(page, 1), total_pages);
    const offset = (safePage - 1) * limit;
    const pagedItems = filteredItems.slice(offset, offset + limit);

    if (includeTeamMetrics) {
      return res.json({
        page: safePage,
        limit,
        total,
        total_pages,
        date: date ?? null,
        from_date: from_date ?? null,
        to_date: to_date ?? null,
        card_summary: {
          total_employees: teamMetrics?.total_employees ?? 0,
          new_employees_this_month: teamMetrics?.new_employees_this_month ?? 0,
        },
        items: pagedItems,
      });
    }

    return res.json({
      page: safePage,
      limit,
      total,
      total_pages,
      date: date ?? null,
      from_date: from_date ?? null,
      to_date: to_date ?? null,
      data: pagedItems,
    });
  }

  static async getAdminCardsSummary(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = attendanceAdminCardsSummaryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const org_id = req.user.org_id;
    const isManager = req.user.role === 'manager';
    let managedDepartmentIds: string[] = [];
    if (isManager) {
      managedDepartmentIds = await getManagedDepartmentIds(org_id, req.user.id);
    }

    const now = new Date();
    const focusDate = parsed.data.date
      ? new Date(parsed.data.date)
      : parsed.data.to_date
        ? new Date(parsed.data.to_date)
        : now;
    const focusDateStr = formatDateLocal(focusDate);
    const todayStr = getTodayDate();

    // Leave-request card period:
    // - date mode / default: month of focus date
    // - range mode: explicit from_date..to_date range
    const monthStart = new Date(focusDate.getFullYear(), focusDate.getMonth(), 1);
    const monthEnd = new Date(focusDate.getFullYear(), focusDate.getMonth() + 1, 0);
    const monthStartStr = formatDateLocal(monthStart);
    const monthEndStr = formatDateLocal(monthEnd);
    const leaveRequestRangeStart = parsed.data.from_date ?? monthStartStr;
    const leaveRequestRangeEnd = parsed.data.to_date ?? monthEndStr;
    const isRangeMode = Boolean(parsed.data.from_date && parsed.data.to_date);
    const rangeStartStr = parsed.data.from_date ?? focusDateStr;
    const rangeEndRawStr = parsed.data.to_date ?? focusDateStr;
    const rangeEndStr = rangeEndRawStr < todayStr ? rangeEndRawStr : todayStr;

    const cardsHolidaySet = await fetchOrgHolidayDateSet(org_id, rangeStartStr, rangeEndStr);

    // Active users in attendance scope (employee/hr/manager) for this org
    const employees = await User.query()
      .alias('u')
      .leftJoin('departments as d', 'd.id', 'u.department_id')
      .leftJoin('work_shifts as ws_user', 'ws_user.id', 'u.shift_id')
      .leftJoin('work_shifts as ws_dept', 'ws_dept.id', 'd.default_shift_id')
      .where('u.org_id', org_id)
      .modify((qb) => {
        if (isManager) {
          if (managedDepartmentIds.length === 0) {
            qb.whereRaw('1 = 0');
            return;
          }

          // Include employees/HR in managed departments AND managers of those departments.
          const managerSubquery = DepartmentManager.query()
            .alias('dm')
            .whereIn('dm.department_id', managedDepartmentIds)
            .select('dm.manager_id');

          qb.where((inner) => {
            inner
              .whereIn('u.department_id', managedDepartmentIds)
              .whereIn('u.role', ['employee', 'hr'])
              .orWhereIn('u.id', managerSubquery);
          });
          return;
        }
        qb.whereIn('u.role', ORG_USER_ROLES);
      })
      .whereIn('u.status', ATTENDANCE_ACTIVE_EMPLOYEE_STATUSES as readonly string[])
      .whereNull('u.deleted_at')
      .select(
        'u.id',
        'u.role',
        'u.department_id',
        'u.shift_id',
        'u.date_of_joining',
        'u.created_at',
        'd.working_days as department_working_days',
        'ws_user.start_time as user_shift_start_time',
        'ws_user.end_time as user_shift_end_time',
        'ws_user.break_start_time as user_shift_break_start_time',
        'ws_user.break_end_time as user_shift_break_end_time',
        'ws_dept.start_time as dept_shift_start_time',
        'ws_dept.end_time as dept_shift_end_time',
        'ws_dept.break_start_time as dept_shift_break_start_time',
        'ws_dept.break_end_time as dept_shift_break_end_time',
      );

    const nowInIST = getNowInIST();
    const nowMinutesIST = nowInIST.getUTCHours() * 60 + nowInIST.getUTCMinutes();
    const lateGracePeriodMins = await getOrgLateGracePeriodMins(org_id);
    const employeeById = new Map<string, any>((employees as any[]).map((e) => [e.id, e]));

    const cardsHolidaySetByUserId = await fetchEffectiveHolidayDateSetsForUsers(
      org_id,
      (employees as any[]).map((e: any) => String(e.id)),
      rangeStartStr,
      rangeEndStr,
    );

    const cardsManagerIdsNeedingFallback = (employees as any[])
      .filter(
        (e: any) =>
          e.role === 'manager' &&
          !(
            e.department_id &&
            Array.isArray(e.department_working_days) &&
            e.department_working_days.length > 0
          ),
      )
      .map((e: any) => String(e.id));
    const cardsManagedScheduleByManagerId = await fetchPrimaryManagedDepartmentScheduleByManagerIds(
      org_id,
      cardsManagerIdsNeedingFallback,
    );
    const effectiveScheduleByUserId = new Map<
      string,
      { departmentId: string | null; workingDays: string[] | null }
    >();
    for (const e of employees as any[]) {
      const eff = resolveEffectiveAttendanceSchedule(
        {
          role: e.role,
          department_id: e.department_id ?? null,
          department_working_days: e.department_working_days,
        },
        cardsManagedScheduleByManagerId.get(String(e.id)),
      );
      effectiveScheduleByUserId.set(String(e.id), eff);
    }

    const getEligibleEmployeeIdsForDate = (dateStr: string): string[] => {
      if (dateStr > todayStr) return [];
      return (employees as any[])
        .filter((e: any) => {
          const resolvedJoinDate = e.date_of_joining ?? e.created_at ?? null;
          const joinDateNormalized = normalizeDate(resolvedJoinDate);
          const joinDateStr = joinDateNormalized || null;
          return !joinDateStr || joinDateStr <= dateStr;
        })
        .map((e: any) => e.id);
    };

    const computeAttendanceForDate = async (dateStr: string) => {
      const joinedEligibleIds = getEligibleEmployeeIdsForDate(dateStr);

      if (joinedEligibleIds.length === 0) {
        return {
          totalEmployees: 0,
          presentCount: 0,
          onLeaveCount: 0,
          halfDayCount: 0,
          absentCount: 0,
          lateCount: 0,
          attendancePercentage: 0,
        };
      }

      const [logs, leavesOnDate] = await Promise.all([
        AttendanceLog.query()
          .alias('al')
          .where('al.org_id', org_id)
          .where('al.date', dateStr)
          .whereIn('al.user_id', joinedEligibleIds)
          .select('al.user_id', 'al.clock_in_time'),
        LeaveRequest.query()
          .alias('lr')
          .where('lr.org_id', org_id)
          .whereIn('lr.user_id', joinedEligibleIds)
          .whereIn('lr.status', ['PENDING', 'APPROVED'])
          .where('lr.start_date', '<=', dateStr)
          .where('lr.end_date', '>=', dateStr)
          .select('lr.user_id', 'lr.day_session'),
      ]);

      const logsByUserId = new Map<string, any>();
      for (const log of logs as any[]) {
        logsByUserId.set(log.user_id, log);
      }

      const leaveSessionByUserId = new Map<string, LeaveDaySession>();
      for (const leave of leavesOnDate as any[]) {
        leaveSessionByUserId.set(
          String(leave.user_id),
          mergeLeaveDaySessions(leaveSessionByUserId.get(String(leave.user_id)), leave.day_session),
        );
      }

      const dayEmployeeIds = joinedEligibleIds.filter((id) => {
        const sched = effectiveScheduleByUserId.get(String(id));
        const scheduled = isUserAttendanceScheduledDay({
          dateStr,
          holidaySet: cardsHolidaySetByUserId.get(String(id)) ?? cardsHolidaySet,
          departmentId: sched?.departmentId ?? null,
          workingDays: sched?.workingDays ?? null,
        });
        return scheduled || logsByUserId.has(id);
      });
      const totalEmployees = dayEmployeeIds.length;

      if (totalEmployees === 0) {
        return {
          totalEmployees,
          presentCount: 0,
          onLeaveCount: 0,
          halfDayCount: 0,
          absentCount: 0,
          lateCount: 0,
          attendancePercentage: 0,
        };
      }

      let presentCount = 0;
      let onLeaveCount = 0;
      let halfDayCount = 0;
      let absentCount = 0;
      let lateCount = 0;
      const isFocusToday = dateStr === todayStr;

      for (const id of dayEmployeeIds) {
        const leaveSession = leaveSessionByUserId.get(id);
        const log = logsByUserId.get(id);
        const leaveDerivedStatus = resolveAdminAttendanceStatus({
          leaveSession,
          hasClockIn: Boolean(log?.clock_in_time),
          evaluationDateStr: dateStr,
          todayStr,
        });

        if (leaveDerivedStatus === 'LEAVE') {
          onLeaveCount += 1;
          continue;
        }

        if (leaveDerivedStatus === 'HALF_DAY') {
          halfDayCount += 1;
          continue;
        }

        if (log) {
          presentCount += 1;
          const employee = employeeById.get(id);
          const shiftStart =
            employee?.user_shift_start_time ?? employee?.dept_shift_start_time ?? null;
          const lateInfo = calculateLateArrival(log.clock_in_time, shiftStart, lateGracePeriodMins);
          if (lateInfo.isLate) lateCount += 1;
          continue;
        }

        const employee = employeeById.get(id);
        const schedRow = effectiveScheduleByUserId.get(String(id));
        const scheduled = isUserAttendanceScheduledDay({
          dateStr,
          holidaySet: cardsHolidaySetByUserId.get(String(id)) ?? cardsHolidaySet,
          departmentId: schedRow?.departmentId ?? null,
          workingDays: schedRow?.workingDays ?? null,
        });
        if (!scheduled) {
          continue;
        }

        const shiftEnd = employee?.user_shift_end_time ?? employee?.dept_shift_end_time ?? null;
        const shiftEndMinutes = parseTimeToMinutes(shiftEnd);
        if (isFocusToday && shiftEnd && nowMinutesIST < shiftEndMinutes) {
          continue;
        }
        absentCount += 1;
      }

      const attendancePercentage =
        totalEmployees > 0 ? Math.round((presentCount / totalEmployees) * 100) : 0;

      return {
        totalEmployees,
        presentCount,
        onLeaveCount,
        halfDayCount,
        absentCount,
        lateCount,
        attendancePercentage,
      };
    };

    const focusSummary = await computeAttendanceForDate(focusDateStr);
    let totalEmployees = focusSummary.totalEmployees;

    if (!isRangeMode && totalEmployees === 0) {
      const cardsByDate: Array<{
        date: string;
        total_employees: number;
        attendance: {
          percentage: number;
          present_count: number;
          days_off_count: number;
          half_day_count: number;
          late_arrival_count: number;
          absent_count: number;
        };
      }> = [];
      if (isRangeMode && rangeEndStr >= rangeStartStr) {
        const cursor = new Date(`${rangeStartStr}T00:00:00.000Z`);
        const rangeEnd = new Date(`${rangeEndStr}T00:00:00.000Z`);
        while (cursor <= rangeEnd) {
          cardsByDate.push({
            date: formatDateLocal(cursor),
            total_employees: 0,
            attendance: {
              percentage: 0,
              present_count: 0,
              days_off_count: 0,
              half_day_count: 0,
              late_arrival_count: 0,
              absent_count: 0,
            },
          });
          cursor.setUTCDate(cursor.getUTCDate() + 1);
        }
      }

      return res.json({
        date: focusDateStr,
        from_date: parsed.data.from_date ?? null,
        to_date: parsed.data.to_date ?? null,
        month: {
          start_date: monthStartStr,
          end_date: monthEndStr,
        },
        cards: {
          total_employees: {
            value: 0,
          },
          attendance: {
            percentage: 0,
            present_count: 0,
            days_off_count: 0,
            half_day_count: 0,
            late_arrival_count: 0,
            absent_count: 0,
          },
          leave_requests: {
            approved_count: 0,
            pending_review_count: 0,
          },
        },
        cards_by_date: cardsByDate,
      });
    }

    let presentCount = focusSummary.presentCount;
    let onLeaveCount = focusSummary.onLeaveCount;
    let halfDayCount = focusSummary.halfDayCount;
    let absentCount = focusSummary.absentCount;
    let lateCount = focusSummary.lateCount;
    let attendancePercentage = focusSummary.attendancePercentage;
    const cardsByDate: Array<{
      date: string;
      total_employees: number;
      attendance: {
        percentage: number;
        present_count: number;
        days_off_count: number;
        half_day_count: number;
        late_arrival_count: number;
        absent_count: number;
      };
    }> = [];

    if (isRangeMode && rangeEndStr >= rangeStartStr) {
      let totalEmployeesAcrossRange = 0;
      let presentAcrossRange = 0;
      let onLeaveAcrossRange = 0;
      let halfDayAcrossRange = 0;
      let absentAcrossRange = 0;
      let lateAcrossRange = 0;

      const cursor = new Date(`${rangeStartStr}T00:00:00.000Z`);
      const rangeEnd = new Date(`${rangeEndStr}T00:00:00.000Z`);
      while (cursor <= rangeEnd) {
        const day = formatDateLocal(cursor);
        const summary = await computeAttendanceForDate(day);
        // Skip pre-joining dates where no scoped employee exists yet.
        if (summary.totalEmployees > 0) {
          cardsByDate.push({
            date: day,
            total_employees: summary.totalEmployees,
            attendance: {
              percentage: summary.attendancePercentage,
              present_count: summary.presentCount,
              days_off_count: summary.onLeaveCount,
              half_day_count: summary.halfDayCount,
              late_arrival_count: summary.lateCount,
              absent_count: summary.absentCount,
            },
          });
          totalEmployeesAcrossRange += summary.totalEmployees;
          presentAcrossRange += summary.presentCount;
          onLeaveAcrossRange += summary.onLeaveCount;
          halfDayAcrossRange += summary.halfDayCount;
          absentAcrossRange += summary.absentCount;
          lateAcrossRange += summary.lateCount;
        }
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }

      presentCount = presentAcrossRange;
      onLeaveCount = onLeaveAcrossRange;
      halfDayCount = halfDayAcrossRange;
      absentCount = absentAcrossRange;
      lateCount = lateAcrossRange;
      totalEmployees =
        cardsByDate.length > 0 ? cardsByDate[cardsByDate.length - 1].total_employees : 0;
      attendancePercentage =
        totalEmployeesAcrossRange > 0
          ? Math.round((presentAcrossRange / totalEmployeesAcrossRange) * 100)
          : 0;
    }

    // Leave requests card (month scope)
    // created_at/updated_at are timestamps; from_date/to_date are YYYY-MM-DD. Expand to full IST-day bounds.
    const leaveCreatedAtStart = new Date(
      `${leaveRequestRangeStart}T00:00:00.000+05:30`,
    ).toISOString();
    const leaveCreatedAtEnd = new Date(`${leaveRequestRangeEnd}T23:59:59.999+05:30`).toISOString();
    const leaveUpdatedAtStart = leaveCreatedAtStart;
    const leaveUpdatedAtEnd = leaveCreatedAtEnd;

    const [approvedRow, pendingRow] = await Promise.all([
      LeaveRequest.query()
        .alias('lr')
        .where('lr.org_id', org_id)
        .modify((qb) => {
          if (isManager) {
            qb.whereIn(
              'lr.user_id',
              User.query()
                .alias('u')
                .select('u.id')
                .where('u.org_id', org_id)
                .whereIn('u.department_id', managedDepartmentIds)
                .where('u.role', 'employee'),
            );
          }
        })
        .where('lr.status', 'APPROVED')
        // Approved count reflects approvals made in the selected range.
        .whereBetween('lr.updated_at', [leaveUpdatedAtStart, leaveUpdatedAtEnd])
        .countDistinct('lr.id as count')
        .first(),
      LeaveRequest.query()
        .alias('lr')
        .where('lr.org_id', org_id)
        .modify((qb) => {
          if (isManager) {
            qb.whereIn(
              'lr.user_id',
              User.query()
                .alias('u')
                .select('u.id')
                .where('u.org_id', org_id)
                .whereIn('u.department_id', managedDepartmentIds)
                .where('u.role', 'employee'),
            );
          }
        })
        .where('lr.status', 'PENDING')
        // Pending_review_count reflects items pending in the selected range.
        .whereBetween('lr.updated_at', [leaveUpdatedAtStart, leaveUpdatedAtEnd])
        .countDistinct('lr.id as count')
        .first(),
    ]);

    const approvedCount = Number(
      (approvedRow as { count?: string | number } | undefined)?.count ?? 0,
    );
    const pendingCount = Number(
      (pendingRow as { count?: string | number } | undefined)?.count ?? 0,
    );

    return res.json({
      date: focusDateStr,
      from_date: parsed.data.from_date ?? null,
      to_date: parsed.data.to_date ?? null,
      month: {
        start_date: monthStartStr,
        end_date: monthEndStr,
      },
      cards: {
        total_employees: {
          value: totalEmployees,
        },
        attendance: {
          percentage: attendancePercentage,
          present_count: presentCount,
          days_off_count: onLeaveCount,
          half_day_count: halfDayCount,
          late_arrival_count: lateCount,
          absent_count: absentCount,
        },
        leave_requests: {
          approved_count: approvedCount,
          pending_review_count: pendingCount,
        },
      },
      cards_by_date: cardsByDate,
    });
  }

  // Download monthly attendance Excel report (grid format: IN / OUT / OT per employee)
  static async downloadAttendanceExcel(req: Request, res: Response): Promise<Response | void> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = attendanceExcelDownloadQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const period = resolveAttendanceExcelPeriod(parsed.data);
    if (!period) {
      return res.status(400).json({
        message: 'Either month and year, or from_date and to_date are required for Excel download',
      });
    }

    const { rangeStart, rangeEnd } = period;
    const { department_id, department, work_model, search, sort_by, sort_dir } = parsed.data;
    const filterDepartmentId = department || department_id;

    const org_id = req.user.org_id;
    const isManager = req.user.role === 'manager';
    let managedDepartmentIds: string[] = [];
    if (isManager) {
      managedDepartmentIds = await getManagedDepartmentIds(org_id, req.user.id);
    }

    const baseQuery = User.query()
      .alias('u')
      .leftJoin('departments as d', 'd.id', 'u.department_id')
      .leftJoin('employee_employment_details as eed', 'eed.user_id', 'u.id')
      .leftJoin('work_shifts as ws_user', 'ws_user.id', 'u.shift_id')
      .leftJoin('work_shifts as ws_dept', 'ws_dept.id', 'd.default_shift_id')
      .where('u.org_id', org_id)
      .modify((qb) => {
        qb.whereIn('u.role', ORG_USER_ROLES);

        if (isManager) {
          if (managedDepartmentIds.length === 0) {
            qb.whereRaw('1 = 0');
            return;
          }

          const managerSubquery = DepartmentManager.query()
            .alias('dm')
            .whereIn('dm.department_id', managedDepartmentIds)
            .select('dm.manager_id');

          qb.where((b) => {
            b.whereIn('u.department_id', managedDepartmentIds).orWhereIn('u.id', managerSubquery);
          });
        }
      })
      .whereIn('u.status', REAL_EMPLOYEE_STATUSES as readonly string[])
      .whereNull('u.deleted_at')
      .whereRaw('COALESCE(u.date_of_joining::date, u.created_at::date) <= ?::date', [rangeEnd]);

    if (filterDepartmentId) {
      const managersInDeptSubquery = DepartmentManager.query()
        .alias('dm')
        .where('dm.department_id', filterDepartmentId)
        .select('dm.manager_id');
      baseQuery.where((b) => {
        b.where('u.department_id', filterDepartmentId).orWhereIn('u.id', managersInDeptSubquery);
      });
    }

    if (work_model) {
      baseQuery.where('eed.work_mode', work_model);
    }

    if (search) {
      const term = `%${search}%`;
      baseQuery.where((qb) => {
        qb.where('u.employee_id', 'ilike', term)
          .orWhere('u.first_name', 'ilike', term)
          .orWhere('u.last_name', 'ilike', term)
          .orWhere('u.official_email', 'ilike', term)
          .orWhere('d.name', 'ilike', term);
      });
    }

    if (sort_by === 'STATUS') {
      baseQuery.orderBy(['u.first_name', 'u.last_name']);
    } else if (sort_by === 'DATE') {
      baseQuery.orderBy('u.created_at', sort_dir === 'DESC' ? 'desc' : 'asc');
    } else {
      baseQuery.orderBy([
        { column: 'u.first_name', order: sort_dir === 'DESC' ? 'desc' : 'asc' },
        { column: 'u.last_name', order: sort_dir === 'DESC' ? 'desc' : 'asc' },
      ]);
    }

    const employeeRows = await baseQuery.select(
      'u.id',
      'u.employee_id',
      'u.first_name',
      'u.last_name',
      'u.designation',
      'u.role',
      'u.date_of_joining',
      'u.created_at',
      'ws_user.start_time as user_shift_start_time',
      'ws_user.end_time as user_shift_end_time',
      'ws_user.break_start_time as user_shift_break_start_time',
      'ws_user.break_end_time as user_shift_break_end_time',
      'ws_user.break_duration_mins as user_shift_break_duration_mins',
      'ws_dept.start_time as dept_shift_start_time',
      'ws_dept.end_time as dept_shift_end_time',
      'ws_dept.break_start_time as dept_shift_break_start_time',
      'ws_dept.break_end_time as dept_shift_break_end_time',
      'ws_dept.break_duration_mins as dept_shift_break_duration_mins',
    );

    if (employeeRows.length === 0) {
      return res.status(404).json({ message: 'No employees found' });
    }

    const excelBuffer = await generateMonthlyAttendanceExcelBuffer({
      orgId: org_id,
      rangeStart,
      rangeEnd,
      employees: employeeRows as any[],
    });

    const fileName = attendanceExcelFileName(rangeStart, rangeEnd);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': excelBuffer.length.toString(),
    });

    res.end(excelBuffer);
  }

  static async downloadAttendanceBulkImportTemplate(
    req: Request,
    res: Response,
  ): Promise<Response | void> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsedQuery = attendanceBulkImportQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsedQuery.error.flatten().fieldErrors,
      });
    }

    const org_id = req.user.org_id;
    const { month, year } = parsedQuery.data;

    const employees = await User.query()
      .where('org_id', org_id)
      .whereNull('deleted_at')
      .whereIn('status', ATTENDANCE_ACTIVE_EMPLOYEE_STATUSES as readonly string[])
      .whereNot('role', 'device')
      .select('official_email', 'first_name', 'last_name')
      .orderBy(['first_name', 'last_name']);

    const buffer = await buildAttendanceBulkImportTemplateBuffer({
      employees: employees.map((e) => ({
        official_email: e.official_email,
        first_name: e.first_name,
        last_name: e.last_name,
      })),
      month,
      year,
    });

    const fileName = attendanceBulkImportTemplateFilename(month, year);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.send(buffer);
  }

  static async bulkImportAttendance(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsedQuery = attendanceBulkImportQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsedQuery.error.flatten().fieldErrors,
      });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const org_id = req.user.org_id;
    const dryRun = parsedQuery.data.dry_run;
    const { month, year } = parsedQuery.data;

    let parsedRows;
    try {
      parsedRows = parseAndPrepareAttendanceBulkImport(req.file.buffer);
    } catch (error) {
      if (error instanceof AttendanceBulkImportParseError) {
        return res.status(400).json({ message: error.message });
      }
      throw error;
    }

    const outcome = dryRun
      ? await validateAttendanceBulkImportRows({
          parsedRows,
          orgId: org_id,
          month,
          year,
        })
      : await importAttendanceBulkRows({
          parsedRows,
          orgId: org_id,
          actorUserId: req.user.id,
          month,
          year,
        });

    return res.status(200).json({
      message: dryRun ? 'Attendance import validation completed' : 'Attendance import completed',
      dry_run: dryRun,
      summary: outcome.summary,
      results: outcome.results,
    });
  }
}
