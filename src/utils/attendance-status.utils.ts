import type { LeaveDaySession } from '../models/LeaveRequest';

export type CalendarAttendanceStatus =
  | 'PRESENT'
  | 'LATE'
  | 'ABSENT'
  | 'LEAVE'
  | 'HOLIDAY'
  | 'HALF_DAY'
  | 'WFH';

export type AdminAttendanceStatus = 'ON_TIME' | 'LATE' | 'LEAVE' | 'ABSENT' | 'HALF_DAY' | 'WFH';

export const ADMIN_VISIBLE_ATTENDANCE_STATUSES: AdminAttendanceStatus[] = [
  'ON_TIME',
  'LATE',
  'HALF_DAY',
  'LEAVE',
  'ABSENT',
  'WFH',
];

export const ADMIN_ATTENDANCE_STATUS_SORT_ORDER: AdminAttendanceStatus[] = [
  'ON_TIME',
  'LATE',
  'HALF_DAY',
  'LEAVE',
  'ABSENT',
  'WFH',
];

export const isHalfDayLeaveSession = (
  leaveSession: LeaveDaySession | string | null | undefined,
): boolean => leaveSession === 'FIRST_HALF' || leaveSession === 'SECOND_HALF';

/** Half-day leave without punch: HALF_DAY on today/future; past dates fall through to ABSENT. */
export function resolveHalfDayNoPunchStatus(params: {
  hasClockIn: boolean;
  evaluationDateStr: string;
  todayStr: string;
}): 'HALF_DAY' | null {
  if (params.hasClockIn) {
    return null;
  }
  if (params.evaluationDateStr < params.todayStr) {
    return null;
  }
  return 'HALF_DAY';
}

export function resolveCalendarAttendanceStatus(params: {
  leaveSession: LeaveDaySession | string | null | undefined;
  hasClockIn: boolean;
  evaluationDateStr: string;
  todayStr: string;
}): CalendarAttendanceStatus | null {
  const leaveSession = params.leaveSession ?? null;
  if (!leaveSession) {
    return null;
  }

  if (leaveSession === 'FULL') {
    return 'LEAVE';
  }

  if (isHalfDayLeaveSession(leaveSession)) {
    return resolveHalfDayNoPunchStatus({
      hasClockIn: params.hasClockIn,
      evaluationDateStr: params.evaluationDateStr,
      todayStr: params.todayStr,
    });
  }

  return null;
}

export function resolveAdminAttendanceStatus(params: {
  leaveSession: LeaveDaySession | string | null | undefined;
  hasClockIn: boolean;
  evaluationDateStr: string;
  todayStr: string;
}): AdminAttendanceStatus | null {
  const leaveSession = params.leaveSession ?? null;
  if (!leaveSession) {
    return null;
  }

  if (leaveSession === 'FULL') {
    return 'LEAVE';
  }

  if (isHalfDayLeaveSession(leaveSession)) {
    return resolveHalfDayNoPunchStatus({
      hasClockIn: params.hasClockIn,
      evaluationDateStr: params.evaluationDateStr,
      todayStr: params.todayStr,
    });
  }

  return null;
}
