import type { PartialModelObject } from 'objection';

import { AttendanceLog } from '../models/AttendanceLog';
import { parseTimeToMinutes, timeStringToISO } from './date.utils';

export const DEFAULT_IMPORT_SHIFT_START = '09:00';
export const DEFAULT_IMPORT_SHIFT_END = '18:00';

export type AttendanceImportStatus = 'PRESENT' | 'ABSENT' | 'LATE';

export function addMinutesToTime(timeHHmm: string, minutesToAdd: number): string {
  const startM = parseTimeToMinutes(timeHHmm);
  const total = startM + minutesToAdd;
  const normalized = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  const hours = Math.floor(normalized / 60);
  const mins = normalized % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

export function buildSyntheticClockTimes(params: {
  date: string;
  importStatus: AttendanceImportStatus;
  totalWorkMinutes: number;
  shiftStartTime: string;
  lateGracePeriodMins: number;
}): { clock_in_time: string | null; clock_out_time: string | null } {
  if (params.importStatus === 'ABSENT') {
    return { clock_in_time: null, clock_out_time: null };
  }

  const clockInTimeStr =
    params.importStatus === 'LATE'
      ? addMinutesToTime(params.shiftStartTime, params.lateGracePeriodMins + 1)
      : params.shiftStartTime;

  const clock_in_time = timeStringToISO(params.date, clockInTimeStr);
  if (!clock_in_time) {
    return { clock_in_time: null, clock_out_time: null };
  }

  const clockInDate = new Date(clock_in_time);
  const clockOutDate = new Date(clockInDate.getTime() + params.totalWorkMinutes * 60 * 1000);

  return {
    clock_in_time,
    clock_out_time: clockOutDate.toISOString(),
  };
}

export function buildAttendanceLogPatchFromImport(params: {
  orgId: string;
  userId: string;
  date: string;
  importStatus: AttendanceImportStatus;
  totalWorkMinutes: number;
  overtimeMinutes: number;
  shiftStartTime: string;
  lateGracePeriodMins: number;
  importedByUserId: string;
  importedAt: string;
}): PartialModelObject<AttendanceLog> {
  const overtimeMinutes = params.importStatus === 'ABSENT' ? 0 : params.overtimeMinutes;
  const { clock_in_time, clock_out_time } = buildSyntheticClockTimes({
    date: params.date,
    importStatus: params.importStatus,
    totalWorkMinutes: params.totalWorkMinutes,
    shiftStartTime: params.shiftStartTime,
    lateGracePeriodMins: params.lateGracePeriodMins,
  });

  const dbStatus = params.importStatus === 'ABSENT' ? 'ABSENT' : 'PRESENT';
  const totalWorkHours = params.importStatus === 'ABSENT' ? 0 : params.totalWorkMinutes / 60;

  return {
    org_id: params.orgId,
    user_id: params.userId,
    date: params.date,
    status: dbStatus,
    clock_in_time,
    clock_out_time,
    total_work_hours: totalWorkHours,
    overtime_minutes: overtimeMinutes,
    imported_at: params.importedAt,
    imported_by_user_id: params.importedByUserId,
    punch_in_lat: null,
    punch_in_long: null,
    punch_out_lat: null,
    punch_out_long: null,
  };
}
