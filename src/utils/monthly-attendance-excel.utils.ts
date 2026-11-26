import ExcelJS from 'exceljs';

import { AttendanceBreak } from '../models/AttendanceBreak';
import { AttendanceLog } from '../models/AttendanceLog';
import { LeaveRequest } from '../models/LeaveRequest';
import { resolveShift } from '../services/attendance-shift.service';
import { User } from '../models/User';
import {
  computeMonthlyShiftBasedOvertimeHours,
  getEffectiveOvertimeSeconds,
} from './attendance-overtime.utils';
import {
  fetchEffectiveHolidayDateSetsForUsers,
  fetchOrgHolidayDateSet,
  isUserAttendanceScheduledDay,
  resolveEffectiveAttendanceSchedule,
  type EffectiveAttendanceSchedule,
} from './attendance-schedule.utils';
import { fetchPrimaryManagedDepartmentScheduleByManagerIds } from './department-manager.utils';
import { getOrgOtRoundOffSettings } from './ot-round-off.utils';
import type { OrgOtRoundOffSettings } from './ot-round-off.utils';
import {
  addCalendarDays,
  formatTimeDotDecimal,
  isCalendarSunday,
  isFullCalendarMonthRange,
  monthEndDateString,
  monthStartDateString,
  normalizeDate,
  parseTimeToMinutes,
} from './date.utils';

export type AttendanceExcelPeriod = {
  rangeStart: string;
  rangeEnd: string;
};

type CalendarDay = {
  dateStr: string;
  dayLabel: string;
  isSunday: boolean;
};

const SUNDAY_FILL = 'FFB4C6E7';
const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin' },
  left: { style: 'thin' },
  bottom: { style: 'thin' },
  right: { style: 'thin' },
};

const MONTH_NAMES = [
  'JANUARY',
  'FEBRUARY',
  'MARCH',
  'APRIL',
  'MAY',
  'JUNE',
  'JULY',
  'AUGUST',
  'SEPTEMBER',
  'OCTOBER',
  'NOVEMBER',
  'DECEMBER',
] as const;

const MONTH_ABBREV = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

export type MonthlyAttendanceEmployeeRow = {
  id: string;
  employee_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  designation?: string | null;
  role?: string | null;
  date_of_joining?: string | null;
  created_at?: string | Date | null;
  user_shift_start_time?: string | null;
  user_shift_end_time?: string | null;
  user_shift_break_start_time?: string | null;
  user_shift_break_end_time?: string | null;
  user_shift_break_duration_mins?: number | null;
  dept_shift_start_time?: string | null;
  dept_shift_end_time?: string | null;
  dept_shift_break_start_time?: string | null;
  dept_shift_break_end_time?: string | null;
  dept_shift_break_duration_mins?: number | null;
};

type DailyCell = {
  inValue: string;
  outValue: string;
  otValue: string;
};

type EmployeeMonthlyReport = {
  slNo: number;
  name: string;
  trade: string;
  days: DailyCell[];
  daysPresent: number;
  sundays: number;
  holidays: number;
  medical: number;
  daysAbsent: number;
  totalDays: number;
  otMonthTotal: number;
};

const isMedicalLeaveTypeName = (name: string | null | undefined): boolean => {
  const lower = (name ?? '').toLowerCase();
  return lower.includes('medical') || lower.includes('sick');
};

const formatOtHoursAndMinutes = (hours: number): string => {
  if (hours <= 0) return '0';
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h} hours ${m} mins`;
};

const formatOtFromSeconds = (seconds: number): string => formatOtHoursAndMinutes(seconds / 3600);

const buildCalendarDaysFromRange = (rangeStart: string, rangeEnd: string): CalendarDay[] => {
  const result: CalendarDay[] = [];
  let current = rangeStart;
  while (current <= rangeEnd) {
    const parts = current.split('-').map(Number);
    const monthIndex = parts[1] - 1;
    const dayNum = parts[2];
    const monthAbbrev = MONTH_ABBREV[monthIndex] ?? 'Mon';
    result.push({
      dateStr: current,
      dayLabel: `${dayNum}-${monthAbbrev}`,
      isSunday: isCalendarSunday(current),
    });
    if (current === rangeEnd) break;
    current = addCalendarDays(current, 1);
  }
  return result;
};

const formatReportTitle = (rangeStart: string, rangeEnd: string): string => {
  if (isFullCalendarMonthRange(rangeStart, rangeEnd)) {
    const [year, month] = rangeStart.split('-').map(Number);
    const monthLabel = MONTH_NAMES[month - 1] ?? 'MONTH';
    return `${monthLabel} ${year} MONTH ATTENDANCE REPORT`;
  }
  const formatPart = (dateStr: string): string => {
    const [year, month, day] = dateStr.split('-').map(Number);
    const monthLabel = MONTH_NAMES[month - 1] ?? 'MONTH';
    return `${day}-${monthLabel.slice(0, 3)}-${year}`;
  };
  return `ATTENDANCE REPORT (${formatPart(rangeStart)} TO ${formatPart(rangeEnd)})`;
};

const formatOtColumnHeader = (rangeStart: string, rangeEnd: string): string => {
  if (isFullCalendarMonthRange(rangeStart, rangeEnd)) {
    const [year, month] = rangeStart.split('-').map(Number);
    const monthAbbrev = MONTH_ABBREV[month - 1] ?? 'Mon';
    const yearShort = String(year).slice(-2);
    return `OT - ${monthAbbrev.toUpperCase()} ${yearShort}`;
  }
  return 'OT HRS';
};

const getEmployeeShift = (row: MonthlyAttendanceEmployeeRow) => ({
  start_time: row.user_shift_start_time ?? row.dept_shift_start_time ?? null,
  end_time: row.user_shift_end_time ?? row.dept_shift_end_time ?? null,
  break_start_time: row.user_shift_break_start_time ?? row.dept_shift_break_start_time ?? null,
  break_end_time: row.user_shift_break_end_time ?? row.dept_shift_break_end_time ?? null,
  break_duration_mins:
    row.user_shift_break_duration_mins ?? row.dept_shift_break_duration_mins ?? null,
});

const expandLeaveDates = (
  leaveRows: Array<{
    user_id: string;
    start_date: string;
    end_date: string;
    leave_type_name?: string | null;
  }>,
  monthStart: string,
  monthEnd: string,
): Map<string, Map<string, { isOnLeave: boolean; isMedical: boolean }>> => {
  const byUser = new Map<string, Map<string, { isOnLeave: boolean; isMedical: boolean }>>();

  for (const leave of leaveRows) {
    const start = normalizeDate(leave.start_date);
    const end = normalizeDate(leave.end_date);
    if (!start || !end) continue;

    const isMedical = isMedicalLeaveTypeName(leave.leave_type_name);
    let current = start;
    while (current <= end) {
      if (current >= monthStart && current <= monthEnd) {
        if (!byUser.has(leave.user_id)) {
          byUser.set(leave.user_id, new Map());
        }
        byUser.get(leave.user_id)!.set(current, { isOnLeave: true, isMedical });
      }
      const parts = current.split('-').map(Number);
      const next = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + 1));
      const y = next.getUTCFullYear();
      const m = String(next.getUTCMonth() + 1).padStart(2, '0');
      const d = String(next.getUTCDate()).padStart(2, '0');
      current = `${y}-${m}-${d}`;
    }
  }

  return byUser;
};

const computeDailyOtSeconds = (
  log: {
    clock_in_time?: string | null;
    clock_out_time?: string | null;
    overtime_minutes?: number | null;
  },
  breaks: Array<{ start_time: string; end_time?: string | null }>,
  shift: ReturnType<typeof getEmployeeShift>,
  isAttendanceScheduledDay: boolean,
  otRoundOff: OrgOtRoundOffSettings,
): number =>
  getEffectiveOvertimeSeconds(
    log,
    breaks,
    shift.start_time,
    shift.end_time,
    {
      break_start_time: shift.break_start_time,
      break_end_time: shift.break_end_time,
      break_duration_mins: shift.break_duration_mins,
    },
    {
      isAttendanceScheduledDay,
      otRoundOffEnabled: otRoundOff.enabled,
      otRoundOffMins: otRoundOff.mins,
    },
  );

async function aggregateEmployeeReports(params: {
  orgId: string;
  rangeStart: string;
  rangeEnd: string;
  calendarDays: CalendarDay[];
  employees: MonthlyAttendanceEmployeeRow[];
}): Promise<EmployeeMonthlyReport[]> {
  const { orgId, rangeStart, rangeEnd, calendarDays, employees } = params;
  const employeeIds = employees.map((e) => e.id);

  if (employeeIds.length === 0) {
    return [];
  }

  const otRoundOff = await getOrgOtRoundOffSettings(orgId);
  const holidaySet = await fetchOrgHolidayDateSet(orgId, rangeStart, rangeEnd);
  const holidaySetByUserId = await fetchEffectiveHolidayDateSetsForUsers(
    orgId,
    employeeIds,
    rangeStart,
    rangeEnd,
  );

  const scheduleRows = await User.query()
    .alias('u')
    .leftJoin('departments as d', 'd.id', 'u.department_id')
    .where('u.org_id', orgId)
    .whereIn('u.id', employeeIds)
    .select('u.id', 'u.role', 'u.department_id', 'd.working_days as department_working_days');

  const managerIdsNeedingFallback = (
    scheduleRows as Array<{
      id: string;
      role?: string;
      department_id?: string | null;
      department_working_days?: unknown;
    }>
  )
    .filter(
      (r) =>
        r.role === 'manager' &&
        !(
          r.department_id &&
          Array.isArray(r.department_working_days) &&
          r.department_working_days.length > 0
        ),
    )
    .map((r) => String(r.id));

  const managedScheduleByManagerId = await fetchPrimaryManagedDepartmentScheduleByManagerIds(
    orgId,
    managerIdsNeedingFallback,
  );

  const scheduleByUserId = new Map<string, EffectiveAttendanceSchedule>();
  for (const r of scheduleRows as Array<{
    id: string;
    role?: string;
    department_id?: string | null;
    department_working_days?: unknown;
  }>) {
    scheduleByUserId.set(
      String(r.id),
      resolveEffectiveAttendanceSchedule(
        {
          role: r.role,
          department_id: r.department_id ?? null,
          department_working_days: r.department_working_days,
        },
        managedScheduleByManagerId.get(String(r.id)),
      ),
    );
  }

  const logRows = await AttendanceLog.query()
    .where('org_id', orgId)
    .whereBetween('date', [rangeStart, rangeEnd])
    .whereIn('user_id', employeeIds)
    .select(
      'id',
      'user_id',
      'date',
      'clock_in_time',
      'clock_out_time',
      'status',
      'overtime_minutes',
    );

  const logsByUserDate = new Map<string, (typeof logRows)[0]>();
  for (const log of logRows) {
    const dateStr = normalizeDate(log.date);
    if (!dateStr) continue;
    logsByUserDate.set(`${log.user_id}|${dateStr}`, log);
  }

  const logIds = logRows.map((l) => l.id);
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

  const leaveRows = await LeaveRequest.query()
    .alias('lr')
    .leftJoin('leave_types as lt', 'lt.id', 'lr.leave_type_id')
    .where('lr.org_id', orgId)
    .whereIn('lr.user_id', employeeIds)
    .where('lr.status', 'APPROVED')
    .where((qb) => {
      qb.whereBetween('lr.start_date', [rangeStart, rangeEnd])
        .orWhereBetween('lr.end_date', [rangeStart, rangeEnd])
        .orWhere((inner) =>
          inner.where('lr.start_date', '<=', rangeStart).where('lr.end_date', '>=', rangeEnd),
        );
    })
    .select('lr.user_id', 'lr.start_date', 'lr.end_date', 'lt.name as leave_type_name');

  const leaveByUserDate = expandLeaveDates(
    leaveRows as Array<{
      user_id: string;
      start_date: string;
      end_date: string;
      leave_type_name?: string | null;
    }>,
    rangeStart,
    rangeEnd,
  );

  const resolvedShiftByUserId = new Map<string, ReturnType<typeof getEmployeeShift>>();
  const reports: EmployeeMonthlyReport[] = [];
  let slNo = 0;

  for (const row of employees) {
    const joinDateStr = normalizeDate(row.date_of_joining ?? row.created_at) || rangeStart;
    const name = `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim();
    const trade = row.designation?.trim() || '—';

    let shift = getEmployeeShift(row);
    if (
      row.role === 'manager' &&
      (!shift.start_time || parseTimeToMinutes(shift.start_time) === 0) &&
      (!shift.end_time || parseTimeToMinutes(shift.end_time) === 0)
    ) {
      if (!resolvedShiftByUserId.has(row.id)) {
        const resolved = await resolveShift(orgId, row.id);
        resolvedShiftByUserId.set(
          row.id,
          resolved
            ? {
                start_time: resolved.start_time ?? null,
                end_time: resolved.end_time ?? null,
                break_start_time: resolved.break_start_time ?? null,
                break_end_time: resolved.break_end_time ?? null,
                break_duration_mins: resolved.break_duration_mins ?? null,
              }
            : shift,
        );
      }
      shift = resolvedShiftByUserId.get(row.id) ?? shift;
    }

    const userLeaveDates = leaveByUserDate.get(row.id) ?? new Map();
    const days: DailyCell[] = calendarDays.map(() => ({
      inValue: '',
      outValue: '',
      otValue: '',
    }));
    let daysPresent = 0;
    let sundays = 0;
    let holidays = 0;
    let medical = 0;
    let daysAbsent = 0;
    let totalDays = 0;

    for (let dayIdx = 0; dayIdx < calendarDays.length; dayIdx++) {
      const { dateStr, isSunday } = calendarDays[dayIdx];
      if (dateStr < joinDateStr) {
        continue;
      }

      totalDays++;
      const userHolidaySet = holidaySetByUserId.get(String(row.id)) ?? holidaySet;
      const isHoliday = userHolidaySet.has(dateStr);
      const leaveInfo = userLeaveDates.get(dateStr);
      const isOnLeave = Boolean(leaveInfo?.isOnLeave);
      const isMedicalLeave = Boolean(leaveInfo?.isMedical);

      if (isSunday) sundays++;
      if (isHoliday && !isSunday) holidays++;

      const log = logsByUserDate.get(`${row.id}|${dateStr}`);
      const isPresent = Boolean(
        log?.clock_in_time || (log?.status && String(log.status).toUpperCase() === 'PRESENT'),
      );

      if (isPresent) daysPresent++;
      if (isMedicalLeave && !isPresent) medical++;

      if (!isPresent && !isSunday && !isHoliday && !isOnLeave) {
        daysAbsent++;
      }

      const skipAbsentMark = isSunday || isHoliday || isOnLeave;
      const inValue = log?.clock_in_time
        ? (formatTimeDotDecimal(log.clock_in_time) ?? '')
        : skipAbsentMark
          ? ''
          : 'A';
      const outValue = log?.clock_out_time
        ? (formatTimeDotDecimal(log.clock_out_time) ?? '')
        : skipAbsentMark
          ? ''
          : 'A';

      let otValue = '0';
      if (log?.clock_in_time && log?.clock_out_time) {
        const breaks = breaksByLogId.get(String(log.id)) ?? [];
        const sched = scheduleByUserId.get(String(row.id));
        const otSeconds = computeDailyOtSeconds(
          log,
          breaks,
          shift,
          isUserAttendanceScheduledDay({
            dateStr,
            holidaySet: userHolidaySet,
            departmentId: sched?.departmentId ?? null,
            workingDays: sched?.workingDays ?? null,
          }),
          otRoundOff,
        );
        otValue = formatOtFromSeconds(otSeconds);
      }

      days[dayIdx] = { inValue, outValue, otValue };
    }

    const otMonthTotal = await computeMonthlyShiftBasedOvertimeHours({
      orgId,
      userId: row.id,
      monthStart: rangeStart,
      monthEnd: rangeEnd,
    });

    slNo++;
    reports.push({
      slNo,
      name,
      trade,
      days,
      daysPresent,
      sundays,
      holidays,
      medical,
      daysAbsent,
      totalDays,
      otMonthTotal,
    });
  }

  return reports;
}

const applyCellStyle = (
  cell: ExcelJS.Cell,
  opts: { bold?: boolean; fillArgb?: string; center?: boolean } = {},
): void => {
  cell.border = THIN_BORDER;
  cell.alignment = { vertical: 'middle', horizontal: opts.center !== false ? 'center' : 'left' };
  if (opts.bold) {
    cell.font = { ...(cell.font ?? {}), bold: true };
  }
  if (opts.fillArgb) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.fillArgb } };
  }
};

export async function buildMonthlyAttendanceWorkbook(params: {
  rangeStart: string;
  rangeEnd: string;
  calendarDays: CalendarDay[];
  reports: EmployeeMonthlyReport[];
}): Promise<ExcelJS.Workbook> {
  const { rangeStart, rangeEnd, calendarDays, reports } = params;
  const dayCount = calendarDays.length;
  const sundayDayIndices = new Set(
    calendarDays.map((d, idx) => (d.isSunday ? idx : -1)).filter((idx) => idx >= 0),
  );

  const summaryStartCol = 5 + dayCount;
  const actualTotalCols = 4 + dayCount + 9;
  const otHeader = formatOtColumnHeader(rangeStart, rangeEnd);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Attendance Report');

  // Title row
  sheet.mergeCells(1, 1, 1, actualTotalCols);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = formatReportTitle(rangeStart, rangeEnd);
  applyCellStyle(titleCell, { bold: true, center: true });
  titleCell.font = { bold: true, size: 14 };

  // Header row
  const headers: string[] = [
    'SL NO',
    'EMPLOYEE NAME',
    'DESIGNATION',
    'TIME IN / OUT',
    ...calendarDays.map((d) => d.dayLabel),
    'NUMBER OF DAYS PRESENT',
    'SUNDAYS',
    'HOLIDAYS',
    'MEDICAL',
    'NUMBER OF DAYS ABSENT',
    'TOTAL DAYS',
    otHeader,
    'REMARKS',
    'SIGN',
  ];

  headers.forEach((header, idx) => {
    const cell = sheet.getCell(2, idx + 1);
    cell.value = header;
    applyCellStyle(cell, { bold: true, center: true });
  });

  let currentRow = 3;
  for (const report of reports) {
    const inRow = currentRow;
    const outRow = currentRow + 1;
    const otRow = currentRow + 2;

    // Merge SL NO, NAME, DESIGNATION across 3 rows
    sheet.mergeCells(inRow, 1, otRow, 1);
    sheet.mergeCells(inRow, 2, otRow, 2);
    sheet.mergeCells(inRow, 3, otRow, 3);

    const slCell = sheet.getCell(inRow, 1);
    slCell.value = report.slNo;
    applyCellStyle(slCell, { center: true });

    const nameCell = sheet.getCell(inRow, 2);
    nameCell.value = report.name;
    applyCellStyle(nameCell, { center: false });

    const tradeCell = sheet.getCell(inRow, 3);
    tradeCell.value = report.trade;
    applyCellStyle(tradeCell, { center: true });

    const rowTypes: Array<{ row: number; label: string; metric: 'in' | 'out' | 'ot' }> = [
      { row: inRow, label: 'IN', metric: 'in' },
      { row: outRow, label: 'OUT', metric: 'out' },
      { row: otRow, label: 'OT IN HRS', metric: 'ot' },
    ];

    for (const { row, label, metric } of rowTypes) {
      const labelCell = sheet.getCell(row, 4);
      labelCell.value = label;
      applyCellStyle(labelCell, { bold: true, center: true });

      for (let dayIdx = 0; dayIdx < dayCount; dayIdx++) {
        const col = 5 + dayIdx;
        const cell = sheet.getCell(row, col);
        const dayData = report.days[dayIdx];
        if (metric === 'in') cell.value = dayData?.inValue ?? '';
        else if (metric === 'out') cell.value = dayData?.outValue ?? '';
        else cell.value = dayData?.otValue ?? '0';

        const fill = sundayDayIndices.has(dayIdx) ? SUNDAY_FILL : undefined;
        applyCellStyle(cell, { center: true, fillArgb: fill });
      }

      // Summary columns (IN row only, except OT total on OUT row)
      const summaryValues: Array<string | number | null> = [
        metric === 'in' ? report.daysPresent : null,
        metric === 'in' ? report.sundays : null,
        metric === 'in' ? report.holidays : null,
        metric === 'in' ? report.medical : null,
        metric === 'in' ? report.daysAbsent : null,
        metric === 'in' ? report.totalDays : null,
        metric === 'out' ? formatOtHoursAndMinutes(report.otMonthTotal) : null,
        null,
        null,
      ];

      summaryValues.forEach((val, idx) => {
        const col = summaryStartCol + idx;
        const cell = sheet.getCell(row, col);
        if (val !== null && val !== undefined) {
          cell.value = val;
        }
        applyCellStyle(cell, { center: true });
      });
    }

    currentRow += 3;
  }

  // Column widths
  sheet.getColumn(1).width = 6;
  sheet.getColumn(2).width = 22;
  sheet.getColumn(3).width = 14;
  sheet.getColumn(4).width = 12;
  for (let c = 5; c < summaryStartCol; c++) {
    sheet.getColumn(c).width = 14;
  }
  for (let c = summaryStartCol; c <= actualTotalCols; c++) {
    sheet.getColumn(c).width = c === summaryStartCol + 6 ? 18 : 12;
  }

  return workbook;
}

export async function generateMonthlyAttendanceExcelBuffer(params: {
  orgId: string;
  rangeStart: string;
  rangeEnd: string;
  employees: MonthlyAttendanceEmployeeRow[];
}): Promise<Buffer> {
  const { orgId, rangeStart, rangeEnd, employees } = params;
  const calendarDays = buildCalendarDaysFromRange(rangeStart, rangeEnd);

  const reports = await aggregateEmployeeReports({
    orgId,
    rangeStart,
    rangeEnd,
    calendarDays,
    employees,
  });

  const workbook = await buildMonthlyAttendanceWorkbook({
    rangeStart,
    rangeEnd,
    calendarDays,
    reports,
  });
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

export function resolveAttendanceExcelPeriod(parsed: {
  month?: number;
  year?: number;
  from_date?: string;
  to_date?: string;
}): AttendanceExcelPeriod | null {
  if (parsed.month !== undefined && parsed.year !== undefined) {
    return {
      rangeStart: monthStartDateString(parsed.year, parsed.month),
      rangeEnd: monthEndDateString(parsed.year, parsed.month),
    };
  }
  if (parsed.from_date && parsed.to_date) {
    return {
      rangeStart: parsed.from_date,
      rangeEnd: parsed.to_date,
    };
  }
  return null;
}

export function attendanceExcelFileName(rangeStart: string, rangeEnd: string): string {
  if (isFullCalendarMonthRange(rangeStart, rangeEnd)) {
    const [year, month] = rangeStart.split('-');
    return `attendance_report_${year}-${month}.xlsx`;
  }
  return `attendance_report_${rangeStart}_to_${rangeEnd}.xlsx`;
}
