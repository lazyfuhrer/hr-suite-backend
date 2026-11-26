import type { Request, Response } from 'express';

import { AttendanceBreak } from '../../models/AttendanceBreak';
import { AttendanceLog } from '../../models/AttendanceLog';
import { EmployeeEmploymentDetail } from '../../models/EmployeeEmploymentDetail';
import { LeaveRequest } from '../../models/LeaveRequest';
import { User } from '../../models/User';
import { DepartmentManager } from '../../models/DepartmentManager';
import { REAL_EMPLOYEE_STATUSES } from '../../constants/user-status';
import { formatDateLocal, formatTime } from '../../utils/date.utils';
import { getManagedDepartmentIds } from '../../utils/department-manager.utils';
import { adminDashboardQuerySchema } from '../../validators';
import {
  DEFAULT_LATE_GRACE_PERIOD_MINS,
  getOrgLateGracePeriodMins,
} from '../../utils/late-grace.utils';

const normalizeDate = (dateValue: string | Date | null | undefined): string => {
  if (!dateValue) return '';
  if (typeof dateValue === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
      return dateValue;
    }
    const date = new Date(dateValue);
    if (!Number.isNaN(date.getTime())) {
      return formatDateLocal(date);
    }
  }
  if (dateValue instanceof Date) {
    return formatDateLocal(dateValue);
  }
  return String(dateValue);
};

const calculateLateArrival = (
  clockInTime: string | null,
  shiftStartTime: string | null,
  graceMins: number = DEFAULT_LATE_GRACE_PERIOD_MINS,
): { isLate: boolean; lateByMinutes: number } => {
  if (!clockInTime || !shiftStartTime) {
    return { isLate: false, lateByMinutes: 0 };
  }

  const clockIn = new Date(clockInTime);
  const shiftStart = new Date(shiftStartTime);

  // Extract only time portion (ignore date)
  const clockInMinutes = clockIn.getHours() * 60 + clockIn.getMinutes();
  const shiftStartMinutes = shiftStart.getHours() * 60 + shiftStart.getMinutes();

  const diff = clockInMinutes - shiftStartMinutes;

  if (diff > graceMins) {
    return { isLate: true, lateByMinutes: diff };
  }

  return { isLate: false, lateByMinutes: 0 };
};

export class DashboardController {
  static async getManagerTeamStats(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    const org_id = req.user.org_id;
    const todayStr = formatDateLocal(new Date());

    if (!['manager', 'hr'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    // Managers see only their managed departments; HR sees org-wide stats
    const isHr = req.user.role === 'hr';

    let totalEmployeesRow;
    let presentEmployeesRow;

    if (isHr) {
      // HR: org-wide employees and attendance
      [totalEmployeesRow, presentEmployeesRow] = await Promise.all([
        User.query()
          .alias('u')
          .where('u.org_id', org_id)
          .whereIn('u.role', ['employee', 'manager', 'hr'])
          .whereIn('u.status', REAL_EMPLOYEE_STATUSES as readonly string[])
          .whereNull('u.deleted_at')
          .countDistinct('u.id as count')
          .first(),
        AttendanceLog.query()
          .alias('al')
          .innerJoin('users as u', 'u.id', 'al.user_id')
          .where('al.org_id', org_id)
          .where('al.date', todayStr)
          .where('u.org_id', org_id)
          .whereIn('u.role', ['employee', 'manager', 'hr'])
          .whereIn('u.status', REAL_EMPLOYEE_STATUSES as readonly string[])
          .whereNull('u.deleted_at')
          .countDistinct('al.user_id as count')
          .first(),
      ]);
    } else {
      // Manager: restrict to managed departments
      const managedDepartmentIds = await getManagedDepartmentIds(org_id, req.user.id);

      if (managedDepartmentIds.length === 0) {
        return res.json({
          date: todayStr,
          my_team: {
            employees: 0,
          },
          attendance: {
            percentage: 0,
            present_count: 0,
            total_employees: 0,
          },
        });
      }

      // Manager view: include employees in managed departments AND managers of those departments.
      const managerSubquery = DepartmentManager.query()
        .alias('dm')
        .whereIn('dm.department_id', managedDepartmentIds)
        .select('dm.manager_id');

      [totalEmployeesRow, presentEmployeesRow] = await Promise.all([
        User.query()
          .alias('u')
          .where('u.org_id', org_id)
          .whereIn('u.status', REAL_EMPLOYEE_STATUSES as readonly string[])
          .whereNull('u.deleted_at')
          .where((qb) => {
            qb.whereIn('u.department_id', managedDepartmentIds)
              .whereIn('u.role', ['employee', 'hr'])
              .orWhereIn('u.id', managerSubquery);
          })
          .countDistinct('u.id as count')
          .first(),
        AttendanceLog.query()
          .alias('al')
          .innerJoin('users as u', 'u.id', 'al.user_id')
          .where('al.org_id', org_id)
          .where('al.date', todayStr)
          .where('u.org_id', org_id)
          .whereIn('u.status', REAL_EMPLOYEE_STATUSES as readonly string[])
          .whereNull('u.deleted_at')
          .where((qb) => {
            qb.whereIn('u.department_id', managedDepartmentIds)
              .whereIn('u.role', ['employee', 'hr'])
              .orWhereIn('u.id', managerSubquery);
          })
          .countDistinct('al.user_id as count')
          .first(),
      ]);
    }

    const totalEmployees = Number(
      (totalEmployeesRow as { count?: string | number } | undefined)?.count ?? 0,
    );
    const presentCount = Number(
      (presentEmployeesRow as { count?: string | number } | undefined)?.count ?? 0,
    );
    const attendancePercentage =
      totalEmployees > 0 ? Math.round((presentCount / totalEmployees) * 100) : 0;

    return res.json({
      date: todayStr,
      my_team: {
        employees: totalEmployees,
      },
      attendance: {
        percentage: attendancePercentage,
        present_count: presentCount,
        total_employees: totalEmployees,
      },
    });
  }

  static async getAdminDashboard(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = adminDashboardQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const org_id = req.user.org_id;
    const lateGracePeriodMins = await getOrgLateGracePeriodMins(org_id);
    const now = new Date();

    // Parse query params
    const month = parsed.data.month ?? now.getMonth() + 1;
    const year = parsed.data.year ?? now.getFullYear();
    const date = parsed.data.date ?? formatDateLocal(now);

    // Calculate month date range
    const startOfMonth = new Date(year, month - 1, 1);
    const endOfMonth = new Date(year, month, 0);
    const monthStartStr = formatDateLocal(startOfMonth);
    const monthEndStr = formatDateLocal(endOfMonth);

    // Calculate previous month for comparison
    const prevMonthDate = new Date(year, month - 2, 1);
    const prevMonth = prevMonthDate.getMonth() + 1;
    const prevYear = prevMonthDate.getFullYear();
    const prevMonthStart = new Date(prevYear, prevMonth - 1, 1);
    const prevMonthEnd = new Date(prevYear, prevMonth, 0);
    const prevMonthStartStr = formatDateLocal(prevMonthStart);
    const prevMonthEndStr = formatDateLocal(prevMonthEnd);

    // Fetch all data in parallel
    const [
      totalEmployeesRow,
      currentMonthLogs,
      currentMonthLeaves,
      employeeRows,
      employmentDetails,
      dateLogs,
      dateLeaves,
    ] = await Promise.all([
      // Total employees
      User.query()
        .where('org_id', org_id)
        .whereIn('role', ['employee', 'manager', 'hr'])
        .whereIn('status', REAL_EMPLOYEE_STATUSES as readonly string[])
        .whereNull('deleted_at')
        .countDistinct('id as count')
        .first(),
      // Current month attendance logs
      AttendanceLog.query()
        .alias('al')
        .where('al.org_id', org_id)
        .whereBetween('al.date', [monthStartStr, monthEndStr])
        .select('al.id', 'al.user_id', 'al.date', 'al.clock_in_time', 'al.clock_out_time'),
      // Current month leave requests
      LeaveRequest.query()
        .where('org_id', org_id)
        .whereIn('status', ['PENDING', 'APPROVED'])
        .where((qb) => {
          qb.whereBetween('start_date', [monthStartStr, monthEndStr])
            .orWhereBetween('end_date', [monthStartStr, monthEndStr])
            .orWhere((inner) =>
              inner.where('start_date', '<=', monthStartStr).where('end_date', '>=', monthEndStr),
            );
        }),
      // All employees with department and shift info
      User.query()
        .alias('u')
        .leftJoin('departments as d', 'd.id', 'u.department_id')
        .leftJoin('work_shifts as ws', 'ws.id', 'u.shift_id')
        .leftJoin('work_shifts as dws', 'dws.id', 'd.default_shift_id')
        .where('u.org_id', org_id)
        .whereIn('u.role', ['employee', 'manager', 'hr'])
        .whereIn('u.status', REAL_EMPLOYEE_STATUSES as readonly string[])
        .whereNull('u.deleted_at')
        .select(
          'u.id',
          'u.employee_id',
          'u.first_name',
          'u.last_name',
          'u.designation',
          'd.id as department_id',
          'd.name as department_name',
          'ws.start_time as user_shift_start_time',
          'ws.end_time as user_shift_end_time',
          'ws.break_start_time as user_shift_break_start_time',
          'ws.break_end_time as user_shift_break_end_time',
          'dws.start_time as dept_shift_start_time',
          'dws.end_time as dept_shift_end_time',
          'dws.break_start_time as dept_shift_break_start_time',
          'dws.break_end_time as dept_shift_break_end_time',
        ),
      // Employment details for employment status breakdown
      EmployeeEmploymentDetail.query()
        .alias('eed')
        .innerJoin('users as u', 'u.id', 'eed.user_id')
        .where('u.org_id', org_id)
        .whereIn('u.role', ['employee', 'manager', 'hr'])
        .whereIn('u.status', REAL_EMPLOYEE_STATUSES as readonly string[])
        .whereNull('u.deleted_at')
        .select('eed.employment_type'),
      // Attendance logs for the specific date
      AttendanceLog.query()
        .alias('al')
        .where('al.org_id', org_id)
        .where('al.date', date)
        .select('al.id', 'al.user_id', 'al.clock_in_time', 'al.clock_out_time', 'al.date'),
      // Leave requests for the specific date
      LeaveRequest.query()
        .alias('lr')
        .where('lr.org_id', org_id)
        .whereIn('lr.status', ['PENDING', 'APPROVED'])
        .where('lr.start_date', '<=', date)
        .where('lr.end_date', '>=', date)
        .select('lr.user_id'),
    ]);

    const totalEmployees = Number(
      (totalEmployeesRow as { count?: string | number } | undefined)?.count ?? 0,
    );

    // Calculate attendance summary for current month
    const logsByUserId = new Map<string, AttendanceLog[]>();
    for (const log of currentMonthLogs) {
      const userId = (log as any).user_id;
      if (!logsByUserId.has(userId)) {
        logsByUserId.set(userId, []);
      }
      logsByUserId.get(userId)!.push(log);
    }

    // Get breaks for current month logs
    const logIds = currentMonthLogs.map((l) => Number((l as any).id)).filter((id) => id > 0);
    const monthBreaks =
      logIds.length > 0
        ? await AttendanceBreak.query()
            .whereIn('attendance_log_id', logIds)
            .select('attendance_log_id', 'start_time', 'end_time')
        : [];

    const breaksByLogId = new Map<
      number,
      Array<{ start_time: string; end_time?: string | null }>
    >();
    for (const brk of monthBreaks) {
      const logId = Number((brk as any).attendance_log_id);
      if (!breaksByLogId.has(logId)) {
        breaksByLogId.set(logId, []);
      }
      breaksByLogId.get(logId)!.push({
        start_time: (brk as any).start_time,
        end_time: (brk as any).end_time,
      });
    }

    // Calculate attendance stats for current month
    // Process leaves for the month
    const leavesByUserId = new Map<string, Set<string>>();
    for (const leave of currentMonthLeaves) {
      const userId = leave.user_id;
      if (!leavesByUserId.has(userId)) {
        leavesByUserId.set(userId, new Set());
      }
      const start = new Date(leave.start_date);
      const end = new Date(leave.end_date);
      const current = new Date(start);
      while (current <= end) {
        const dateKey = formatDateLocal(current);
        if (dateKey >= monthStartStr && dateKey <= monthEndStr) {
          leavesByUserId.get(userId)!.add(dateKey);
        }
        current.setDate(current.getDate() + 1);
      }
    }

    // Calculate monthly attendance summary
    let totalPresentDays = 0;
    let totalDaysOff = 0;
    let totalLateArrivals = 0;

    // Group logs by user and date
    const logsByUserAndDate = new Map<string, Map<string, AttendanceLog>>();
    for (const log of currentMonthLogs) {
      const userId = (log as any).user_id;
      const logDate = normalizeDate((log as any).date);
      if (!logsByUserAndDate.has(userId)) {
        logsByUserAndDate.set(userId, new Map());
      }
      logsByUserAndDate.get(userId)!.set(logDate, log);
    }

    // Calculate attendance for each employee for the month
    for (const row of employeeRows as any[]) {
      const userId = row.id;
      const userLeaves = leavesByUserId.get(userId) ?? new Set();
      const userLogsByDate = logsByUserAndDate.get(userId) ?? new Map();
      const shiftStartTime = row.user_shift_start_time ?? row.dept_shift_start_time ?? null;

      const totalDaysInMonth = endOfMonth.getDate();
      for (let day = 1; day <= totalDaysInMonth; day++) {
        const checkDate = new Date(year, month - 1, day);
        const dateKey = formatDateLocal(checkDate);

        if (userLeaves.has(dateKey)) {
          // On leave - don't count as present or absent
          continue;
        }

        const log = userLogsByDate.get(dateKey);
        if (log) {
          totalPresentDays++;
          const lateInfo = calculateLateArrival(
            (log as any).clock_in_time,
            shiftStartTime,
            lateGracePeriodMins,
          );
          if (lateInfo.isLate) {
            totalLateArrivals++;
          }
        } else {
          totalDaysOff++;
        }
      }
    }

    // Calculate attendance percentage (present days / total possible days)
    const totalPossibleDays = totalEmployees * endOfMonth.getDate();
    const attendancePercentage =
      totalPossibleDays > 0
        ? Math.round((totalPresentDays / totalPossibleDays) * 100 * 100) / 100
        : 0;

    // Calculate previous month attendance for comparison
    const prevMonthLogs = await AttendanceLog.query()
      .alias('al')
      .where('al.org_id', org_id)
      .whereBetween('al.date', [prevMonthStartStr, prevMonthEndStr])
      .count('* as count')
      .first();

    const prevMonthPresentDays = Number(
      (prevMonthLogs as { count?: string | number } | undefined)?.count ?? 0,
    );
    const prevMonthTotalDays = prevMonthEnd.getDate();
    const prevMonthTotalPossibleDays = totalEmployees * prevMonthTotalDays;
    const prevMonthAttendancePercentage =
      prevMonthTotalPossibleDays > 0
        ? Math.round((prevMonthPresentDays / prevMonthTotalPossibleDays) * 100 * 100) / 100
        : 0;

    const attendanceChange = attendancePercentage - prevMonthAttendancePercentage;

    // Calculate leave requests summary
    const approvedLeaves = currentMonthLeaves.filter((l) => l.status === 'APPROVED').length;
    const pendingLeaves = currentMonthLeaves.filter((l) => l.status === 'PENDING').length;
    const totalLeaveRequests = approvedLeaves + pendingLeaves;

    // Build employee attendance table for the specific date
    const dateLeaveUserIds = new Set<string>(dateLeaves.map((l: any) => l.user_id));
    const dateLogsByUserId = new Map<string, AttendanceLog>();
    for (const log of dateLogs) {
      dateLogsByUserId.set((log as any).user_id, log);
    }

    // Get breaks for date logs
    const dateLogIds = dateLogs.map((l) => Number((l as any).id)).filter((id) => id > 0);
    const dateBreaks =
      dateLogIds.length > 0
        ? await AttendanceBreak.query()
            .whereIn('attendance_log_id', dateLogIds)
            .select('attendance_log_id', 'start_time', 'end_time')
        : [];

    const dateBreaksByLogId = new Map<
      number,
      Array<{ start_time: string; end_time?: string | null }>
    >();
    for (const brk of dateBreaks) {
      const logId = Number((brk as any).attendance_log_id);
      if (!dateBreaksByLogId.has(logId)) {
        dateBreaksByLogId.set(logId, []);
      }
      dateBreaksByLogId.get(logId)!.push({
        start_time: (brk as any).start_time,
        end_time: (brk as any).end_time,
      });
    }

    const employeeAttendanceTable: Array<{
      name: string;
      job_title: string;
      date: string;
      check_in: string | null;
      check_out: string | null;
      status: 'On-Time' | 'Late' | 'On Leave' | 'Absent';
    }> = [];

    let dateOnTime = 0;
    let dateLate = 0;
    let dateOnLeave = 0;
    let dateAbsent = 0;

    for (const row of employeeRows as any[]) {
      const userId = row.id;
      const log = dateLogsByUserId.get(userId);
      const isOnLeave = dateLeaveUserIds.has(userId);

      const fullName = `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim();
      const jobTitle = row.designation ?? 'N/A';

      if (isOnLeave) {
        employeeAttendanceTable.push({
          name: fullName,
          job_title: jobTitle,
          date,
          check_in: null,
          check_out: null,
          status: 'On Leave',
        });
        dateOnLeave++;
      } else if (log) {
        const shiftStartTime = row.user_shift_start_time ?? row.dept_shift_start_time ?? null;
        const lateInfo = calculateLateArrival(
          (log as any).clock_in_time,
          shiftStartTime,
          lateGracePeriodMins,
        );

        // Format time to AM/PM
        const clockInTime = formatTime((log as any).clock_in_time);
        const clockOutTime = formatTime((log as any).clock_out_time);

        const formatTimeAMPM = (timeStr: string | null): string | null => {
          if (!timeStr) return null;
          const [hours, minutes] = timeStr.split(':').map(Number);
          const period = hours >= 12 ? 'PM' : 'AM';
          const displayHours = hours % 12 || 12;
          return `${String(displayHours).padStart(2, '0')}:${String(minutes).padStart(2, '0')} ${period}`;
        };

        employeeAttendanceTable.push({
          name: fullName,
          job_title: jobTitle,
          date,
          check_in: formatTimeAMPM(clockInTime),
          check_out: formatTimeAMPM(clockOutTime),
          status: lateInfo.isLate ? 'Late' : 'On-Time',
        });

        if (lateInfo.isLate) {
          dateLate++;
        } else {
          dateOnTime++;
        }
      } else {
        employeeAttendanceTable.push({
          name: fullName,
          job_title: jobTitle,
          date,
          check_in: null,
          check_out: null,
          status: 'Absent',
        });
        dateAbsent++;
      }
    }

    // Calculate employment status breakdown
    const employmentTypeCounts = new Map<string, number>();
    for (const detail of employmentDetails as any[]) {
      const type = detail.employment_type || 'FULL_TIME'; // Default to FULL_TIME if null
      employmentTypeCounts.set(type, (employmentTypeCounts.get(type) ?? 0) + 1);
    }

    const employmentStatusBreakdown = [
      {
        type: 'full_time',
        label: 'Full-Time',
        count: employmentTypeCounts.get('FULL_TIME') ?? 0,
        percentage:
          totalEmployees > 0
            ? Math.round(((employmentTypeCounts.get('FULL_TIME') ?? 0) / totalEmployees) * 100)
            : 0,
      },
      {
        type: 'part_time',
        label: 'Part-Time',
        count: employmentTypeCounts.get('PART_TIME') ?? 0,
        percentage:
          totalEmployees > 0
            ? Math.round(((employmentTypeCounts.get('PART_TIME') ?? 0) / totalEmployees) * 100)
            : 0,
      },
      {
        type: 'freelance',
        label: 'Freelance',
        count: employmentTypeCounts.get('CONTRACT') ?? 0,
        percentage:
          totalEmployees > 0
            ? Math.round(((employmentTypeCounts.get('CONTRACT') ?? 0) / totalEmployees) * 100)
            : 0,
      },
      {
        type: 'internship',
        label: 'Internship',
        count: employmentTypeCounts.get('INTERN') ?? 0,
        percentage:
          totalEmployees > 0
            ? Math.round(((employmentTypeCounts.get('INTERN') ?? 0) / totalEmployees) * 100)
            : 0,
      },
    ];

    // Build calendar with highlighted dates
    const calendarEntries: Array<{ date: string; highlighted: boolean }> = [];
    const highlightedDates = new Set<string>();

    // Get all attendance dates for the month
    const attendanceDates = new Set<string>();
    for (const log of currentMonthLogs) {
      const dateKey = normalizeDate((log as any).date);
      if (dateKey >= monthStartStr && dateKey <= monthEndStr) {
        attendanceDates.add(dateKey);
      }
    }

    // Highlight dates with attendance (simplified - can be enhanced)
    for (const dateKey of attendanceDates) {
      highlightedDates.add(dateKey);
    }

    const cursor = new Date(startOfMonth);
    while (cursor <= endOfMonth) {
      const dateKey = formatDateLocal(cursor);
      calendarEntries.push({
        date: dateKey,
        highlighted: highlightedDates.has(dateKey),
      });
      cursor.setDate(cursor.getDate() + 1);
    }

    // Build attendance report heatmap (showing attendance by time slots and day of week)
    const timeSlots = ['8:00 AM', '8:30 AM', '9:00 AM', '9:30 AM', '10:00 AM', '10:30 AM'];
    const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

    // Group logs by day of week and clock-in time
    const heatmapByTimeAndDay = new Map<string, number>(); // Key: "timeSlot-dayIndex", Value: count

    for (const log of currentMonthLogs) {
      if (!(log as any).clock_in_time) continue;

      const logDate = new Date((log as any).date);
      const dayOfWeek = logDate.getDay(); // 0 = Sunday, 1 = Monday, etc.
      // Map to Mon-Fri (0-4)
      const mappedDay = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      if (mappedDay < 0 || mappedDay > 4) continue; // Skip weekends

      const clockIn = new Date((log as any).clock_in_time);
      const hours = clockIn.getHours();
      const minutes = clockIn.getMinutes();
      const totalMinutes = hours * 60 + minutes;

      // Map clock-in time to time slot
      let timeSlotIndex = -1;
      if (totalMinutes >= 480 && totalMinutes < 510)
        timeSlotIndex = 0; // 8:00-8:30
      else if (totalMinutes >= 510 && totalMinutes < 540)
        timeSlotIndex = 1; // 8:30-9:00
      else if (totalMinutes >= 540 && totalMinutes < 570)
        timeSlotIndex = 2; // 9:00-9:30
      else if (totalMinutes >= 570 && totalMinutes < 600)
        timeSlotIndex = 3; // 9:30-10:00
      else if (totalMinutes >= 600 && totalMinutes < 630)
        timeSlotIndex = 4; // 10:00-10:30
      else if (totalMinutes >= 630) timeSlotIndex = 5; // 10:30+

      if (timeSlotIndex >= 0 && timeSlotIndex < timeSlots.length) {
        const key = `${timeSlotIndex}-${mappedDay}`;
        heatmapByTimeAndDay.set(key, (heatmapByTimeAndDay.get(key) ?? 0) + 1);
      }
    }

    // Build heatmap entries
    const heatmapData: Array<{
      time: string;
      day: string;
      count: number;
      intensity: number; // 0-100 for color intensity
    }> = [];

    const maxCount = Math.max(...Array.from(heatmapByTimeAndDay.values()), 1);

    for (let timeIdx = 0; timeIdx < timeSlots.length; timeIdx++) {
      for (let dayIdx = 0; dayIdx < dayNames.length; dayIdx++) {
        const key = `${timeIdx}-${dayIdx}`;
        const count = heatmapByTimeAndDay.get(key) ?? 0;
        const intensity = Math.round((count / maxCount) * 100);

        heatmapData.push({
          time: timeSlots[timeIdx],
          day: dayNames[dayIdx],
          count,
          intensity,
        });
      }
    }

    // Calculate attendance rate change
    const attendanceRateChange =
      prevMonthAttendancePercentage > 0
        ? Math.round((attendanceChange / prevMonthAttendancePercentage) * 100 * 100) / 100
        : 0;

    // Calculate attendance summary for the card
    // For the card, we show overall month stats
    const attendancePresent = totalPresentDays; // Total present days across all employees
    const attendanceDaysOff = totalDaysOff; // Total days off across all employees
    const attendanceLateArrivals = totalLateArrivals; // Total late arrivals across all employees

    return res.json({
      summary_cards: {
        total_employees: {
          count: totalEmployees,
          message: "You're part of a growing team!",
        },
        attendance: {
          percentage: attendancePercentage,
          present: attendancePresent, // Count of present days
          days_off: attendanceDaysOff,
          late_arrivals: attendanceLateArrivals,
          message: 'Your attendance this month is looking solid',
        },
        leave_requests: {
          approved: approvedLeaves,
          pending_review: pendingLeaves,
          total: totalLeaveRequests,
          message:
            totalLeaveRequests > 0
              ? `You've submitted ${totalLeaveRequests} leave requests this month`
              : 'No leave requests this month',
        },
        job_applicants: {}, // Empty object as requested
      },
      employee_attendance: {
        summary: {
          on_time: dateOnTime,
          late: dateLate,
          on_leave: dateOnLeave,
          absent: dateAbsent,
        },
        table: employeeAttendanceTable,
        period: {
          month,
          year,
          date, // The specific date shown in the table
        },
      },
      employment_status: {
        total_employees: totalEmployees,
        breakdown: employmentStatusBreakdown,
      },
      calendar: {
        month,
        year,
        entries: calendarEntries,
      },
      attendance_report: {
        attendance_rate: attendancePercentage,
        change_percentage: attendanceRateChange,
        change_display:
          attendanceRateChange >= 0
            ? `+${attendanceRateChange.toFixed(2)}%`
            : `${attendanceRateChange.toFixed(2)}%`,
        heatmap: heatmapData,
        period: {
          month,
          year,
        },
      },
      schedules: {}, // Empty object as requested
      team_performance: {}, // Empty object as requested
      employee_satisfaction: {}, // Empty object as requested
      tasks: {}, // Empty object as requested
      recent_activities: {}, // Empty object as requested
    });
  }
}
