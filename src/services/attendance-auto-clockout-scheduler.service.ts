import { logger } from '../config/logger';
import { AttendanceBreak } from '../models/AttendanceBreak';
import { AttendanceLog } from '../models/AttendanceLog';
import { OfficeLocation } from '../models/OfficeLocation';
import { resolveShift } from './attendance-shift.service';
import { parseTimeToMinutes } from '../utils/date.utils';

const ONE_MINUTE_MS = 60 * 1000;
const IST_OFFSET_MINUTES = 330;

const pad2 = (value: number): string => String(value).padStart(2, '0');

const getNowInISTParts = () => {
  const now = new Date();
  const ist = new Date(now.getTime() + IST_OFFSET_MINUTES * 60 * 1000);
  return {
    hour: ist.getUTCHours(),
    minute: ist.getUTCMinutes(),
    date: `${ist.getUTCFullYear()}-${pad2(ist.getUTCMonth() + 1)}-${pad2(ist.getUTCDate())}`,
  };
};

const addDays = (dateStr: string, days: number): string => {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return dateStr;
  }
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const toIsoAtIst = (dateStr: string, minutesSinceMidnight: number): string => {
  const hours = Math.floor(minutesSinceMidnight / 60);
  const minutes = Math.max(0, minutesSinceMidnight % 60);
  const istDateStr = `${dateStr}T${pad2(hours)}:${pad2(minutes)}:00+05:30`;
  return new Date(istDateStr).toISOString();
};

const normalizeDepartmentLocationIds = (department?: {
  location_id?: string | null;
  location_ids?: string[] | string | null;
}): string[] => {
  if (!department) {
    return [];
  }

  if (Array.isArray(department.location_ids) && department.location_ids.length > 0) {
    return department.location_ids.filter((id): id is string => typeof id === 'string');
  }

  if (typeof department.location_ids === 'string') {
    // Handle accidental JSON-stringified arrays from older data paths.
    try {
      const parsed = JSON.parse(department.location_ids);
      if (Array.isArray(parsed)) {
        return parsed.filter((id): id is string => typeof id === 'string');
      }
    } catch {
      // Ignore parse errors and fallback to legacy location_id.
    }
  }

  return department.location_id ? [department.location_id] : [];
};

const calculateBreakMinutesUntil = (
  breaks: Array<{ start_time: string; end_time?: string | null }>,
  clockOutAt: Date,
): number => {
  let totalMinutes = 0;

  for (const brk of breaks) {
    const start = new Date(brk.start_time);
    if (Number.isNaN(start.getTime())) {
      continue;
    }

    const rawEnd = brk.end_time ? new Date(brk.end_time) : clockOutAt;
    if (Number.isNaN(rawEnd.getTime())) {
      continue;
    }

    const end = rawEnd.getTime() > clockOutAt.getTime() ? clockOutAt : rawEnd;
    if (end.getTime() <= start.getTime()) {
      continue;
    }

    totalMinutes += (end.getTime() - start.getTime()) / 60000;
  }

  return Math.max(0, Math.round(totalMinutes));
};

const finalizeMissedClockOuts = async (): Promise<void> => {
  const nowIst = getNowInISTParts();
  const targetDate = addDays(nowIst.date, -1);

  const openLogs = await AttendanceLog.query()
    .alias('al')
    .leftJoin('users as u', 'u.id', 'al.user_id')
    .leftJoin('departments as d', 'd.id', 'u.department_id')
    .leftJoin('work_shifts as ws_user', 'ws_user.id', 'u.shift_id')
    .leftJoin('work_shifts as ws_dept', 'ws_dept.id', 'd.default_shift_id')
    .where('al.date', targetDate)
    .whereNull('al.clock_out_time')
    .select(
      'al.id',
      'al.user_id',
      'al.org_id',
      'al.clock_in_time',
      'd.location_id as dept_location_id',
      'd.location_ids as dept_location_ids',
      'ws_user.start_time as user_shift_start_time',
      'ws_user.end_time as user_shift_end_time',
      'ws_user.break_start_time as user_shift_break_start_time',
      'ws_user.break_end_time as user_shift_break_end_time',
      'ws_dept.start_time as dept_shift_start_time',
      'ws_dept.end_time as dept_shift_end_time',
      'ws_dept.break_start_time as dept_shift_break_start_time',
      'ws_dept.break_end_time as dept_shift_break_end_time',
    );

  if (openLogs.length === 0) {
    return;
  }

  const fallbackDepartmentLocationIds = new Set<string>();
  for (const row of openLogs as any[]) {
    const locationIds = normalizeDepartmentLocationIds({
      location_id: row.dept_location_id ?? null,
      location_ids: row.dept_location_ids ?? null,
    });
    for (const locationId of locationIds) {
      fallbackDepartmentLocationIds.add(locationId);
    }
  }

  const departmentLocationMap = new Map<string, { latitude: string; longitude: string }>();
  if (fallbackDepartmentLocationIds.size > 0) {
    const locations = await OfficeLocation.query()
      .whereIn('id', Array.from(fallbackDepartmentLocationIds))
      .select('id', 'latitude', 'longitude');

    for (const location of locations as any[]) {
      const lat = Number(location.latitude);
      const lon = Number(location.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        continue;
      }
      departmentLocationMap.set(String(location.id), {
        latitude: String(location.latitude),
        longitude: String(location.longitude),
      });
    }
  }

  let processedCount = 0;

  for (const row of openLogs as any[]) {
    let shiftStart = row.user_shift_start_time ?? row.dept_shift_start_time ?? null;
    let shiftEnd = row.user_shift_end_time ?? row.dept_shift_end_time ?? null;

    if (!shiftStart || !shiftEnd) {
      const shift = await resolveShift(row.org_id, row.user_id);
      if (!shift?.start_time || !shift?.end_time) {
        continue;
      }
      shiftStart = shift.start_time;
      shiftEnd = shift.end_time;
    }

    const shiftStartMinutes = parseTimeToMinutes(shiftStart);
    const shiftEndMinutes = parseTimeToMinutes(shiftEnd);
    const triggerMinutes = (((shiftStartMinutes - 4 * 60) % (24 * 60)) + 24 * 60) % (24 * 60);
    const nowMinutes = nowIst.hour * 60 + nowIst.minute;

    // Run on next day once IST time has reached (shift start - 4h); retries each minute until closed.
    if (nowMinutes < triggerMinutes) {
      continue;
    }

    const clockOutDate = shiftEndMinutes < shiftStartMinutes ? addDays(targetDate, 1) : targetDate;
    const clockOutIso = toIsoAtIst(clockOutDate, shiftEndMinutes);
    const clockOutAt = new Date(clockOutIso);
    const clockInAt = row.clock_in_time ? new Date(row.clock_in_time) : null;

    if (!clockInAt || Number.isNaN(clockInAt.getTime()) || Number.isNaN(clockOutAt.getTime())) {
      continue;
    }

    const activeBreaks = await AttendanceBreak.query()
      .where('attendance_log_id', row.id)
      .whereNull('end_time')
      .select('id', 'start_time');

    for (const brk of activeBreaks as any[]) {
      const breakStart = new Date(brk.start_time);
      if (Number.isNaN(breakStart.getTime())) {
        continue;
      }
      const safeEnd =
        breakStart.getTime() > clockOutAt.getTime() ? breakStart.toISOString() : clockOutIso;
      await AttendanceBreak.query().patch({ end_time: safeEnd }).where('id', brk.id);
    }

    const allBreaks = await AttendanceBreak.query()
      .where('attendance_log_id', row.id)
      .whereNotNull('end_time')
      .select('start_time', 'end_time');

    const grossMinutes = Math.max(0, (clockOutAt.getTime() - clockInAt.getTime()) / 60000);
    const breakMinutes = calculateBreakMinutesUntil(allBreaks as any, clockOutAt);
    const totalMinutes = Math.max(0, Math.round(grossMinutes - breakMinutes));
    const totalHours = Math.round((totalMinutes / 60) * 100) / 100;

    const departmentLocationIds = normalizeDepartmentLocationIds({
      location_id: row.dept_location_id ?? null,
      location_ids: row.dept_location_ids ?? null,
    });
    const fallbackLocation = departmentLocationIds
      .map((id) => departmentLocationMap.get(id))
      .find((location) => Boolean(location));

    const patchPayload: Record<string, unknown> = {
      clock_out_time: clockOutIso,
      total_work_hours: totalHours,
    };
    if (fallbackLocation) {
      // Keep coordinate values as strings to align with DECIMAL handling from pg/knex.
      patchPayload.punch_out_lat = fallbackLocation.latitude;
      patchPayload.punch_out_long = fallbackLocation.longitude;
    }

    await AttendanceLog.query().patch(patchPayload).where('id', row.id).whereNull('clock_out_time');

    processedCount += 1;
  }

  if (processedCount > 0) {
    logger.info(
      { date: nowIst.date, processed_count: processedCount },
      'Auto clock-out scheduler finalized missed clock-out records',
    );
  }
};

export function startAttendanceAutoClockOutScheduler(): void {
  const run = async () => {
    try {
      await finalizeMissedClockOuts();
    } catch (error) {
      logger.error({ err: error }, 'Auto clock-out scheduler run failed');
    }
  };

  // Trigger once on startup and then once per minute after the daily trigger time.
  void run();
  setInterval(() => {
    void run();
  }, ONE_MINUTE_MS);
}
