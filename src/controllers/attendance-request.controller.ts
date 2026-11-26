import type { Request, Response } from 'express';
import { z } from 'zod';

import { AttendanceCorrectionRequest } from '../models/AttendanceCorrectionRequest';
import { AttendanceBreak } from '../models/AttendanceBreak';
import { AttendanceLog } from '../models/AttendanceLog';
import { User } from '../models/User';
import { LeaveRequest } from '../models/LeaveRequest';
import { HelpdeskTicket } from '../models/HelpdeskTicket';
//import { Department } from '../models/Department';
import { logger } from '../config/logger';
import { buildIsoFromDateAndTimeLocal, formatDateLocal, formatTime } from '../utils/date.utils';
import {
  canCancelRequestForOwner,
  getManagedDepartmentIds,
  getManagedDepartmentSummaries,
} from '../utils/department-manager.utils';
import { buildLeaveDaysContextForRows, countLeaveDaysForRow } from '../utils/leave.utils';
import {
  buildOverlapDepartmentIdsFromRow,
  calculateApprovedDepartmentTeammateOverlapCount,
  resolveOverlapDepartmentIds,
} from '../utils/leave-teammate-overlap.utils';
import {
  attendanceCorrectionApproveSchema,
  attendanceCorrectionCreateSchema,
  attendanceCorrectionListMyQuerySchema,
  attendanceCorrectionListPendingQuerySchema,
  attendanceCorrectionStatusUpdateSchema,
  attendanceRegularizationCreateSchema,
  attendanceRegularizationDetailsQuerySchema,
  requestCancelBodySchema,
} from '../validators';
import {
  ACTIVITY_ENTITY_TYPES,
  ACTIVITY_TYPES,
  ActivityLogService,
} from '../services/activity-log.service';
import {
  applyUserDepartmentGraphSelect,
  buildEmployeeSummary,
} from '../utils/employee-summary.utils';

const calculateWorkHours = (clockIn: string, clockOut: string): number => {
  const start = new Date(clockIn);
  const end = new Date(clockOut);
  const diff = end.getTime() - start.getTime();
  if (Number.isNaN(diff) || diff <= 0) {
    return -1;
  }
  return Math.round((diff / 3600000) * 100) / 100;
};

const isValidDateString = (value: string): boolean => {
  const parts = value.split('-').map((part) => Number(part));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    return false;
  }
  const [year, month, day] = parts;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
};

const dateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
  .refine(isValidDateString, 'Invalid calendar date');

const upperEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(
    (value) => (typeof value === 'string' ? value.toUpperCase() : value),
    z.enum(values),
  );

const combinedRequestsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(10),
    status: upperEnum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
    start_date: dateStringSchema.optional(),
    end_date: dateStringSchema.optional(),
    from_date: dateStringSchema.optional(),
    to_date: dateStringSchema.optional(),
  })
  .refine(
    (data) => {
      const hasFrom = Boolean(data.from_date);
      const hasTo = Boolean(data.to_date);
      return hasFrom === hasTo;
    },
    { message: 'from_date and to_date must be provided together' },
  )
  .refine(
    (data) => {
      if (data.start_date && data.end_date) {
        return new Date(data.start_date) <= new Date(data.end_date);
      }
      if (data.from_date && data.to_date) {
        return new Date(data.from_date) <= new Date(data.to_date);
      }
      return true;
    },
    { message: 'Invalid date range' },
  );

const toLowerSafe = (value: unknown): unknown =>
  typeof value === 'string' ? value.toLowerCase() : value;

const buildPaginatedResponse = (
  page: number,
  limit: number,
  total: number,
  items: any[],
): {
  page: number;
  limit: number;
  total: number;
  total_pages: number;
  items: any[];
} => ({
  page,
  limit,
  total,
  total_pages: Math.max(1, Math.ceil(total / limit)),
  items,
});

const formatAttendanceRequestItem = (
  row: any,
  options?: { employee?: any; original_time?: string | null },
) => ({
  id: row.id,
  request_type: 'ATTENDANCE',
  status: row.status,
  created_at: row.created_at ?? null,
  updated_at: row.updated_at ?? null,
  updated_by: row.updated_by ?? null,
  employee: options?.employee ?? null,
  request_date: row.request_date ?? null,
  wrong_punch_type: row.wrong_punch_type ?? null,
  corrected_time: row.corrected_time ?? null,
  original_time: options?.original_time ?? null,
  requested_clock_in: row.requested_clock_in ?? null,
  requested_clock_out: row.requested_clock_out ?? null,
  reason: row.reason ?? null,
  attachment_url: row.attachment_url ?? null,
  manager_status: toLowerSafe(row.manager_status) ?? null,
  hr_status: toLowerSafe(row.hr_status) ?? null,
  approver_comment: row.approver_comment ?? null,
  manager_id: row.manager_id ?? null,
  hr_id: row.hr_id ?? null,
  approver_id: row.approver_id ?? null,
  attendance_log_id: row.attendance_log_id ?? null,
  record: {
    id: row.id,
    user_id: row.user_id,
    attendance_log_id: row.attendance_log_id ?? null,
    request_date: row.request_date ?? null,
    requested_clock_in: row.requested_clock_in ?? null,
    requested_clock_out: row.requested_clock_out ?? null,
    reason: row.reason ?? null,
    status: row.status,
    manager_id: row.manager_id ?? null,
    approver_id: row.approver_id ?? null,
    manager_status: row.manager_status ?? null,
    hr_status: row.hr_status ?? null,
    hr_id: row.hr_id ?? null,
    manager_action_at: row.manager_action_at ?? null,
    hr_action_at: row.hr_action_at ?? null,
    wrong_punch_type: row.wrong_punch_type ?? null,
    corrected_time: row.corrected_time ?? null,
    break_corrections: row.break_corrections ?? null,
    attachment_url: row.attachment_url ?? null,
    approver_comment: row.approver_comment ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    updated_by: row.updated_by ?? null,
  },
});

const CLOCK_IN_PUNCH_TYPES = new Set(['CLOCK_IN', 'MISSING_IN', 'WRONG_IN']);
const CLOCK_OUT_PUNCH_TYPES = new Set(['CLOCK_OUT', 'MISSING_OUT', 'WRONG_OUT']);

const resolveOriginalPunchTimestampByTypeFromTimes = (
  wrongPunchType: string | null | undefined,
  times: { clock_in_time?: string | null; clock_out_time?: string | null } | undefined,
): string | null => {
  if (!wrongPunchType || !times) {
    return null;
  }
  const normalized = wrongPunchType.toUpperCase();
  if (CLOCK_IN_PUNCH_TYPES.has(normalized)) {
    return times.clock_in_time ?? null;
  }
  if (CLOCK_OUT_PUNCH_TYPES.has(normalized)) {
    return times.clock_out_time ?? null;
  }
  return null;
};

const resolveOriginalPunchTimestampByType = (
  wrongPunchType: string | null | undefined,
  log: AttendanceLog | undefined,
): string | null => {
  if (!wrongPunchType || !log) {
    return null;
  }

  const normalized = wrongPunchType.toUpperCase();
  if (CLOCK_IN_PUNCH_TYPES.has(normalized)) {
    return log.clock_in_time ?? null;
  }
  if (CLOCK_OUT_PUNCH_TYPES.has(normalized)) {
    return log.clock_out_time ?? null;
  }

  return null;
};

const enrichAttendanceRequestsWithOriginalPunchTimestamp = async (
  rows: any[],
): Promise<
  Array<{
    row: any;
    original_time: string | null;
  }>
> => {
  if (rows.length === 0) {
    return [];
  }

  const attendanceLogIds = Array.from(
    new Set(
      rows
        .map((row) =>
          row.attendance_log_id !== null && row.attendance_log_id !== undefined
            ? String(row.attendance_log_id)
            : null,
        )
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const userIds = Array.from(new Set(rows.map((row) => row.user_id).filter((id) => Boolean(id))));
  const requestDates = Array.from(
    new Set(rows.map((row) => row.request_date).filter((date) => Boolean(date))),
  );

  const logsById = new Map<string, AttendanceLog>();
  const logsByUserDate = new Map<string, AttendanceLog>();

  if (attendanceLogIds.length > 0) {
    const logsByIdRows = await AttendanceLog.query()
      .whereIn('id', attendanceLogIds)
      .select('id', 'user_id', 'date', 'clock_in_time', 'clock_out_time');
    for (const log of logsByIdRows as any[]) {
      logsById.set(String(log.id), log as AttendanceLog);
    }
  }

  if (userIds.length > 0 && requestDates.length > 0) {
    const fallbackLogs = await AttendanceLog.query()
      .whereIn('user_id', userIds as string[])
      .whereIn('date', requestDates as string[])
      .select('id', 'user_id', 'date', 'clock_in_time', 'clock_out_time');
    for (const log of fallbackLogs as any[]) {
      const key = `${log.user_id}|${String(log.date).slice(0, 10)}`;
      if (!logsByUserDate.has(key)) {
        logsByUserDate.set(key, log as AttendanceLog);
      }
    }
  }

  return rows.map((row) => {
    if (row.original_punch_time) {
      return {
        row,
        original_time: formatTime(String(row.original_punch_time)),
      };
    }

    // After approval, attendance_logs reflect corrected punches; deriving original_time from
    // the current log duplicates corrected_time when original_punch_time was never stored.
    const statusUpper = String(row.status ?? '').toUpperCase();
    if (statusUpper === 'APPROVED') {
      return { row, original_time: null };
    }

    const logById =
      row.attendance_log_id !== null && row.attendance_log_id !== undefined
        ? logsById.get(String(row.attendance_log_id))
        : undefined;
    const fallbackKey =
      row.user_id && row.request_date ? `${row.user_id}|${String(row.request_date)}` : null;
    const fallbackLog = fallbackKey ? logsByUserDate.get(fallbackKey) : undefined;
    const sourceLog = logById ?? fallbackLog;
    return {
      row,
      original_time: formatTime(
        resolveOriginalPunchTimestampByType(row.wrong_punch_type, sourceLog),
      ),
    };
  });
};

export class AttendanceRequestController {
  static async listMy(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = attendanceCorrectionListMyQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const me = await User.query()
      .alias('u')
      .leftJoin('departments as d', 'd.id', 'u.department_id')
      .where('u.id', req.user.id)
      .where('u.org_id', req.user.org_id)
      .select(
        'u.id',
        'u.employee_id',
        'u.first_name',
        'u.last_name',
        'u.profile_image_url',
        'u.role',
        'u.designation',
        'd.id as department_id',
        'd.name as department_name',
      )
      .first();

    const requestedPage = Number(req.query.page ?? 1);
    const requestedLimit = Number(req.query.limit ?? 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100)
      : 10;
    const page = Number.isFinite(requestedPage) ? Math.max(Math.trunc(requestedPage), 1) : 1;

    const query = AttendanceCorrectionRequest.query()
      .where('user_id', req.user.id)
      .orderBy('created_at', 'desc');

    if (parsed.data.status) {
      query.where('status', parsed.data.status);
    }
    if (parsed.data.start_date && parsed.data.end_date) {
      query.whereBetween('request_date', [parsed.data.start_date, parsed.data.end_date]);
    }

    const countQuery = AttendanceCorrectionRequest.query().where('user_id', req.user.id);
    if (parsed.data.status) {
      countQuery.where('status', parsed.data.status);
    }
    if (parsed.data.start_date && parsed.data.end_date) {
      countQuery.whereBetween('request_date', [parsed.data.start_date, parsed.data.end_date]);
    }

    const totalRow = await countQuery.countDistinct('id as count').first();
    const total = Number((totalRow as { count?: string | number } | undefined)?.count ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(page, totalPages);
    const offset = (safePage - 1) * limit;

    const rows = await query.clone().limit(limit).offset(offset);
    const enrichedRows = await enrichAttendanceRequestsWithOriginalPunchTimestamp(rows as any[]);
    const items = enrichedRows.map(({ row, original_time }) =>
      formatAttendanceRequestItem(row, { original_time, employee: buildEmployeeSummary(me) }),
    );

    return res.json(buildPaginatedResponse(safePage, limit, total, items));
  }

  static async listPending(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = attendanceCorrectionListPendingQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    // Requests for this org (join user for org_id filter)
    const statuses =
      parsed.data.statuses && parsed.data.statuses.length > 0
        ? parsed.data.statuses
        : parsed.data.status
          ? [parsed.data.status]
          : undefined;

    const { page, limit } = parsed.data;
    const isManager = req.user.role === 'manager';
    const isHr = req.user.role === 'hr';
    let managedDepartmentIds: string[] = [];
    if (isManager) {
      managedDepartmentIds = await getManagedDepartmentIds(req.user.org_id, req.user.id);
    }

    const baseQuery = applyUserDepartmentGraphSelect(
      AttendanceCorrectionRequest.query()
        .withGraphJoined('[user.department]')
        .where('user.org_id', req.user.org_id)
        .modify((qb) => {
          if (isManager) {
            qb.whereIn('user.department_id', managedDepartmentIds).where('user.role', 'employee');
          }
          // Managers & HR should not see their own requests in org lists
          if (isManager || isHr) {
            qb.whereNot('attendance_correction_requests.user_id', req.user.id);
          }
        })
        .orderBy('attendance_correction_requests.created_at', 'desc'),
    );

    if (statuses && statuses.length > 0) {
      baseQuery.whereIn('attendance_correction_requests.status', statuses);
    }

    const rangeFrom = parsed.data.from_date ?? parsed.data.start_date;
    const rangeTo = parsed.data.to_date ?? parsed.data.end_date;
    if (rangeFrom && rangeTo) {
      baseQuery.whereBetween('request_date', [rangeFrom, rangeTo]);
    }

    // Step filtering: who needs to act next (only meaningful when looking at pending requests)
    if (statuses && statuses.length === 1 && statuses[0] === 'PENDING') {
      if (parsed.data.step === 'MANAGER') {
        baseQuery.where('manager_status', 'PENDING');
      } else if (parsed.data.step === 'HR') {
        baseQuery.where('manager_status', 'APPROVED').where('hr_status', 'PENDING');
      }
    }

    // Use a simpler query for count to avoid DISTINCT + joined columns issues in Postgres.
    const countQuery = AttendanceCorrectionRequest.query()
      .alias('acr')
      .leftJoin('users as user', 'user.id', 'acr.user_id')
      .where('user.org_id', req.user.org_id)
      .modify((qb) => {
        if (isManager) {
          qb.whereIn('user.department_id', managedDepartmentIds).where('user.role', 'employee');
        }
        if (isManager || isHr) {
          qb.whereNot('acr.user_id', req.user.id);
        }
      });

    if (statuses && statuses.length > 0) {
      countQuery.whereIn('acr.status', statuses);
    }

    if (rangeFrom && rangeTo) {
      countQuery.whereBetween('request_date', [rangeFrom, rangeTo]);
    }

    if (statuses && statuses.length === 1 && statuses[0] === 'PENDING') {
      if (parsed.data.step === 'MANAGER') {
        countQuery.where('manager_status', 'PENDING');
      } else if (parsed.data.step === 'HR') {
        countQuery.where('manager_status', 'APPROVED').where('hr_status', 'PENDING');
      }
    }

    const totalRow = await countQuery.countDistinct('acr.id as count').first();
    const total = Number((totalRow as { count?: string | number } | undefined)?.count ?? 0);
    const total_pages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(Math.max(page, 1), total_pages);
    const offset = (safePage - 1) * limit;

    const rows = await baseQuery.clone().limit(limit).offset(offset);

    // Build department array for manager employees (consistent with /api/users)
    const orgId = req.user.org_id;
    const managerUserIds = (rows as any[])
      .map((row: any) => row.user)
      .filter((user: any) => user && user.role === 'manager')
      .map((user: any) => String(user.id));

    const managerDepartmentsMap = await getManagedDepartmentSummaries(orgId, managerUserIds);

    // Normalize manager/hr statuses to lowercase for the API response
    const enrichedRows = await enrichAttendanceRequestsWithOriginalPunchTimestamp(rows as any[]);
    const items = enrichedRows.map(({ row, original_time }) => {
      const user = (row as any).user;

      let manager_departments: Array<{ id: string; name: string }> | undefined;
      if (user && user.role === 'manager') {
        const fromMap = managerDepartmentsMap.get(String(user.id)) ?? [];
        manager_departments = [...fromMap];

        const directDeptId = user.department_id ?? user.department?.id ?? null;
        const directDeptName = user.department_name ?? user.department?.name ?? null;

        if (directDeptId && directDeptName) {
          const deptIdStr = String(directDeptId);
          if (!manager_departments.some((d) => d.id === deptIdStr)) {
            manager_departments.push({
              id: deptIdStr,
              name: String(directDeptName),
            });
          }
        }
      }

      const employeeSource = manager_departments ? { ...user, manager_departments } : user;

      return {
        ...formatAttendanceRequestItem(row, {
          original_time,
          employee: buildEmployeeSummary(employeeSource),
        }),
        details: {
          request_date: row.request_date,
          wrong_punch_type: row.wrong_punch_type,
          corrected_time: row.corrected_time,
          original_time,
        },
      };
    });

    return res.json(buildPaginatedResponse(safePage, limit, total, items));
  }

  /**
   * Attendance correction/regularization requests for a specific employee (admin/hr/manager view).
   * GET /api/users/:userId/attendance/requests
   */
  static async listForUser(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const role = (req.user as any).role;
    if (!['admin', 'hr', 'manager'].includes(role)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const { userId } = req.params;
    const targetUser = await User.query().findById(userId).where('org_id', req.user.org_id);
    if (!targetUser) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const parsed = attendanceCorrectionListPendingQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const statuses =
      parsed.data.statuses && parsed.data.statuses.length > 0
        ? parsed.data.statuses
        : parsed.data.status
          ? [parsed.data.status]
          : undefined;

    const { page, limit } = parsed.data;

    const baseQuery = applyUserDepartmentGraphSelect(
      AttendanceCorrectionRequest.query()
        .alias('acr')
        .withGraphJoined('[user.department]')
        .where('user.org_id', req.user.org_id)
        .where('acr.user_id', userId)
        .orderBy('acr.created_at', 'desc'),
    );

    if (statuses && statuses.length > 0) {
      baseQuery.whereIn('acr.status', statuses);
    }

    const rangeFrom = parsed.data.from_date ?? parsed.data.start_date;
    const rangeTo = parsed.data.to_date ?? parsed.data.end_date;
    if (rangeFrom && rangeTo) {
      baseQuery.whereBetween('request_date', [rangeFrom, rangeTo]);
    }

    if (statuses && statuses.length === 1 && statuses[0] === 'PENDING') {
      if (parsed.data.step === 'MANAGER') {
        baseQuery.where('manager_status', 'PENDING');
      } else if (parsed.data.step === 'HR') {
        baseQuery.where('manager_status', 'APPROVED').where('hr_status', 'PENDING');
      }
    }

    const countQuery = AttendanceCorrectionRequest.query()
      .alias('acr')
      .leftJoin('users as user', 'user.id', 'acr.user_id')
      .where('user.org_id', req.user.org_id)
      .where('acr.user_id', userId);

    if (statuses && statuses.length > 0) {
      countQuery.whereIn('acr.status', statuses);
    }

    if (rangeFrom && rangeTo) {
      countQuery.whereBetween('request_date', [rangeFrom, rangeTo]);
    }

    if (statuses && statuses.length === 1 && statuses[0] === 'PENDING') {
      if (parsed.data.step === 'MANAGER') {
        countQuery.where('manager_status', 'PENDING');
      } else if (parsed.data.step === 'HR') {
        countQuery.where('manager_status', 'APPROVED').where('hr_status', 'PENDING');
      }
    }

    const totalRow = await countQuery.countDistinct('acr.id as count').first();
    const total = Number((totalRow as { count?: string | number } | undefined)?.count ?? 0);
    const total_pages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(Math.max(page, 1), total_pages);
    const offset = (safePage - 1) * limit;

    const rows = await baseQuery.clone().limit(limit).offset(offset);

    const enrichedRows = await enrichAttendanceRequestsWithOriginalPunchTimestamp(rows as any[]);

    // Build department arrays for manager employees (consistent with /api/users)
    const org_id = req.user.org_id;
    const managerUserIds = (rows as any[])
      .filter((row: any) => (row as any).user?.role === 'manager')
      .map((row: any) => String((row as any).user.id));

    const managerDepartmentsMap = await getManagedDepartmentSummaries(org_id, managerUserIds);

    const items = enrichedRows.map(({ row, original_time }) => {
      const user = (row as any).user;
      let employeeSource: any = user;

      if (user && user.role === 'manager') {
        const managerId = String(user.id);
        const managerDepts = managerDepartmentsMap.get(managerId) ?? [];
        employeeSource =
          managerDepts.length > 0 ? { ...user, manager_departments: managerDepts } : user;
      }

      return {
        ...formatAttendanceRequestItem(row, {
          original_time,
          employee: buildEmployeeSummary(employeeSource),
        }),
        details: {
          request_date: row.request_date,
          wrong_punch_type: row.wrong_punch_type,
          corrected_time: row.corrected_time,
          original_time,
        },
      };
    });

    return res.json(buildPaginatedResponse(safePage, limit, total, items));
  }

  /**
   * Attendance correction/regularization requests for current JWT user.
   * GET /api/users/:userId/attendance/requests/my
   *
   * Note: path param userId is intentionally ignored; JWT user id is used.
   * Query params and response shape match listForUser.
   */
  static async listForCurrentUserFromPath(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const userId = req.user.id;
    const parsed = attendanceCorrectionListPendingQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const statuses =
      parsed.data.statuses && parsed.data.statuses.length > 0
        ? parsed.data.statuses
        : parsed.data.status
          ? [parsed.data.status]
          : undefined;

    const { page, limit } = parsed.data;

    const baseQuery = applyUserDepartmentGraphSelect(
      AttendanceCorrectionRequest.query()
        .alias('acr')
        .withGraphJoined('[user.department]')
        .where('user.org_id', req.user.org_id)
        .where('acr.user_id', userId)
        .orderBy('acr.created_at', 'desc'),
    );

    if (statuses && statuses.length > 0) {
      baseQuery.whereIn('acr.status', statuses);
    }

    const rangeFrom = parsed.data.from_date ?? parsed.data.start_date;
    const rangeTo = parsed.data.to_date ?? parsed.data.end_date;
    if (rangeFrom && rangeTo) {
      baseQuery.whereBetween('request_date', [rangeFrom, rangeTo]);
    }

    if (statuses && statuses.length === 1 && statuses[0] === 'PENDING') {
      if (parsed.data.step === 'MANAGER') {
        baseQuery.where('manager_status', 'PENDING');
      } else if (parsed.data.step === 'HR') {
        baseQuery.where('manager_status', 'APPROVED').where('hr_status', 'PENDING');
      }
    }

    const countQuery = AttendanceCorrectionRequest.query()
      .alias('acr')
      .leftJoin('users as user', 'user.id', 'acr.user_id')
      .where('user.org_id', req.user.org_id)
      .where('acr.user_id', userId);

    if (statuses && statuses.length > 0) {
      countQuery.whereIn('acr.status', statuses);
    }

    if (rangeFrom && rangeTo) {
      countQuery.whereBetween('request_date', [rangeFrom, rangeTo]);
    }

    if (statuses && statuses.length === 1 && statuses[0] === 'PENDING') {
      if (parsed.data.step === 'MANAGER') {
        countQuery.where('manager_status', 'PENDING');
      } else if (parsed.data.step === 'HR') {
        countQuery.where('manager_status', 'APPROVED').where('hr_status', 'PENDING');
      }
    }

    const totalRow = await countQuery.countDistinct('acr.id as count').first();
    const total = Number((totalRow as { count?: string | number } | undefined)?.count ?? 0);
    const total_pages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(Math.max(page, 1), total_pages);
    const offset = (safePage - 1) * limit;

    const rows = await baseQuery.clone().limit(limit).offset(offset);
    const enrichedRows = await enrichAttendanceRequestsWithOriginalPunchTimestamp(rows as any[]);
    const managerDepartmentsMapForMe =
      req.user.role === 'manager'
        ? await getManagedDepartmentSummaries(req.user.org_id, [userId])
        : new Map<string, Array<{ id: string; name: string }>>();
    const items = enrichedRows.map(({ row, original_time }) => {
      const user = (row as any).user;
      let employeeSource: any = user;
      if (user && user.role === 'manager') {
        const managerId = String(user.id);
        const managerDepts = managerDepartmentsMapForMe.get(managerId) ?? [];
        employeeSource =
          managerDepts.length > 0 ? { ...user, manager_departments: managerDepts } : user;
      }
      return {
        ...formatAttendanceRequestItem(row, {
          original_time,
          employee: buildEmployeeSummary(employeeSource),
        }),
        details: {
          request_date: row.request_date,
          wrong_punch_type: row.wrong_punch_type,
          corrected_time: row.corrected_time,
          original_time,
        },
      };
    });

    return res.json(buildPaginatedResponse(safePage, limit, total, items));
  }
  /**
   * Combined org activity feed: attendance corrections/regularizations + leave requests only.
   * Reimbursements are excluded; use /api/reimbursements/requests.
   * Sorted by created_at (latest first) and paginated.
   */
  static async listOrgCombined(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const role = (req.user as any).role;
    if (!['admin', 'hr', 'manager'].includes(role)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const parsed = combinedRequestsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const safePage = parsed.data.page;
    const safeLimit = parsed.data.limit;
    const status = parsed.data.status;
    const rangeFrom = parsed.data.from_date ?? parsed.data.start_date;
    const rangeTo = parsed.data.to_date ?? parsed.data.end_date;

    const org_id = req.user.org_id;
    const isManager = req.user.role === 'manager';
    const isHr = req.user.role === 'hr';
    let managedDepartmentIds: string[] = [];
    if (isManager) {
      managedDepartmentIds = await getManagedDepartmentIds(org_id, req.user.id);
    }

    // 1) Attendance requests with user info
    const attendanceRows = await applyUserDepartmentGraphSelect(
      AttendanceCorrectionRequest.query()
        .alias('acr')
        .withGraphJoined('[user.department]')
        .where('user.org_id', org_id)
        .modify((qb) => {
          if (isManager) {
            qb.whereIn('user.department_id', managedDepartmentIds).where('user.role', 'employee');
          }
          // Managers & HR should not see their own requests in org lists
          if (isManager || isHr) {
            qb.whereNot('acr.user_id', req.user.id);
          }
          if (status) {
            qb.where('acr.status', status);
          }
          if (rangeFrom && rangeTo) {
            qb.whereBetween('acr.request_date', [rangeFrom, rangeTo]);
          }
        })
        .select('acr.*')
        .orderBy('acr.created_at', 'desc'),
    );

    // 2) Leave requests with user + leave_type info
    const leaveRows = await LeaveRequest.query()
      .alias('lr')
      .leftJoin('users', 'users.id', 'lr.user_id')
      .leftJoin('leave_types', 'leave_types.id', 'lr.leave_type_id')
      .leftJoin('departments', 'departments.id', 'users.department_id')
      .where('lr.org_id', org_id)
      .modify((qb) => {
        if (isManager) {
          qb.whereIn('users.department_id', managedDepartmentIds).where('users.role', 'employee');
        }
        if (isManager || isHr) {
          qb.whereNot('lr.user_id', req.user.id);
        }
        if (status) {
          qb.where('lr.status', status);
        }
        if (rangeFrom && rangeTo) {
          qb.where((inner) => {
            inner
              .whereBetween('lr.start_date', [rangeFrom, rangeTo])
              .orWhereBetween('lr.end_date', [rangeFrom, rangeTo])
              .orWhere((overlap) =>
                overlap.where('lr.start_date', '<=', rangeFrom).where('lr.end_date', '>=', rangeTo),
              );
          });
        }
      })
      .select(
        'lr.*',
        'leave_types.name as leave_type_name',
        'users.employee_id',
        'users.first_name',
        'users.last_name',
        'users.profile_image_url',
        'users.role',
        'users.designation',
        'users.department_id',
        'departments.name as department_name',
        'departments.working_days as department_working_days',
      )
      .orderBy('lr.created_at', 'desc');

    const {
      holidaySet: orgCombinedHolidaySet,
      holidaySetByUserId: orgCombinedHolidaySetByUserId,
      managedScheduleByManagerId: orgCombinedManagedSchedule,
    } = await buildLeaveDaysContextForRows(org_id, leaveRows as any[]);

    // Build department arrays for manager users appearing in either list
    const managerUserIdsFromAttendance = (attendanceRows as any[])
      .map((row: any) => row.user)
      .filter((user: any) => user && user.role === 'manager')
      .map((user: any) => String(user.id));

    const managerUserIdsFromLeave = (leaveRows as any[])
      .filter((row: any) => row.role === 'manager')
      .map((row: any) => String(row.user_id));

    const managerDepartmentsMap = await getManagedDepartmentSummaries(org_id, [
      ...managerUserIdsFromAttendance,
      ...managerUserIdsFromLeave,
    ]);

    const combined: any[] = [];

    const enrichedAttendanceRows = await enrichAttendanceRequestsWithOriginalPunchTimestamp(
      attendanceRows as any[],
    );
    for (const attendanceEntry of enrichedAttendanceRows) {
      const row = attendanceEntry.row;
      const user = (row as any).user;

      let manager_departments: Array<{ id: string; name: string }> | undefined;
      if (user && user.role === 'manager') {
        const fromMap = managerDepartmentsMap.get(String(user.id)) ?? [];
        manager_departments = [...fromMap];

        const directDeptId = user.department_id ?? user.department?.id ?? null;
        const directDeptName = user.department_name ?? user.department?.name ?? null;

        if (directDeptId && directDeptName) {
          const deptIdStr = String(directDeptId);
          if (!manager_departments.some((d) => d.id === deptIdStr)) {
            manager_departments.push({
              id: deptIdStr,
              name: String(directDeptName),
            });
          }
        }
      }

      const employeeSource = manager_departments ? { ...user, manager_departments } : user;

      combined.push({
        ...formatAttendanceRequestItem(row, {
          original_time: attendanceEntry.original_time,
          employee: buildEmployeeSummary(employeeSource),
        }),
        details: {
          request_date: row.request_date,
          wrong_punch_type: row.wrong_punch_type,
          corrected_time: row.corrected_time,
          original_time: attendanceEntry.original_time,
        },
      });
    }

    for (const row of leaveRows as any[]) {
      let manager_departments: Array<{ id: string; name: string }> | undefined;
      if (row.role === 'manager') {
        const fromMap = managerDepartmentsMap.get(String(row.user_id)) ?? [];
        manager_departments = [...fromMap];

        if (row.department_id && row.department_name) {
          const deptIdStr = String(row.department_id);
          if (!manager_departments.some((d) => d.id === deptIdStr)) {
            manager_departments.push({
              id: deptIdStr,
              name: String(row.department_name),
            });
          }
        }
      }

      const overlapDepartmentIds = buildOverlapDepartmentIdsFromRow(row, managerDepartmentsMap);
      const approvedDepartmentTeammateOverlapCount =
        await calculateApprovedDepartmentTeammateOverlapCount({
          org_id,
          request_id: row.id,
          user_id: row.user_id,
          department_ids: overlapDepartmentIds,
          start_date: row.start_date,
          end_date: row.end_date,
        });

      const employeeSource = manager_departments
        ? { ...row, id: row.user_id, manager_departments }
        : { ...row, id: row.user_id };

      combined.push({
        request_type: 'LEAVE',
        id: row.id,
        employee: buildEmployeeSummary(employeeSource),
        status: row.status,
        created_at: row.created_at,
        updated_at: row.updated_at ?? null,
        updated_by: row.updated_by ?? null,
        reason: row.reason ?? null,
        approver_comment: row.approver_comment ?? null,
        manager_status: row.manager_status ?? null,
        hr_status: row.hr_status ?? null,
        hr_id: row.hr_id ?? null,
        manager_action_at: row.manager_action_at ?? null,
        hr_action_at: row.hr_action_at ?? null,
        details: {
          start_date: row.start_date,
          end_date: row.end_date,
          leave_type_name: row.leave_type_name,
          teammate_overlap_count: approvedDepartmentTeammateOverlapCount,
        },
        record: {
          id: row.id,
          user_id: row.user_id,
          leave_type_id: row.leave_type_id ?? null,
          start_date: row.start_date,
          end_date: row.end_date,
          day_session: row.day_session ?? 'FULL',
          total_days: countLeaveDaysForRow({
            row,
            holidaySet: orgCombinedHolidaySet,
            holidaySetByUserId: orgCombinedHolidaySetByUserId,
            managedScheduleByManagerId: orgCombinedManagedSchedule,
          }),
          status: row.status,
          reason: row.reason ?? null,
          attachment_url: row.attachment_url ?? null,
          approver_comment: row.approver_comment ?? null,
          manager_id: row.manager_id ?? null,
          manager_status: row.manager_status ?? null,
          hr_status: row.hr_status ?? null,
          hr_id: row.hr_id ?? null,
          manager_action_at: row.manager_action_at ?? null,
          hr_action_at: row.hr_action_at ?? null,
          created_at: row.created_at ?? null,
          updated_at: row.updated_at ?? null,
          updated_by: row.updated_by ?? null,
        },
      });
    }

    combined.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const total = combined.length;
    const total_pages = Math.max(1, Math.ceil(total / safeLimit));
    const pageIndex = Math.min(safePage, total_pages);
    const offset = (pageIndex - 1) * safeLimit;
    const paged = combined.slice(offset, offset + safeLimit);

    return res.json(buildPaginatedResponse(pageIndex, safeLimit, total, paged));
  }

  /**
   * Combined requests for a specific employee (attendance + leave only).
   * GET /api/users/:userId/requests/combined
   */
  static async listOrgCombinedForUser(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const role = (req.user as any).role;
    if (!['admin', 'hr', 'manager'].includes(role)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const { userId } = req.params;
    const targetUser = await User.query().findById(userId).where('org_id', req.user.org_id);
    if (!targetUser) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const parsed = combinedRequestsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const safePage = parsed.data.page;
    const safeLimit = parsed.data.limit;
    const status = parsed.data.status;
    const rangeFrom = parsed.data.from_date ?? parsed.data.start_date;
    const rangeTo = parsed.data.to_date ?? parsed.data.end_date;

    const org_id = req.user.org_id;

    const attendanceRows = await applyUserDepartmentGraphSelect(
      AttendanceCorrectionRequest.query()
        .alias('acr')
        .withGraphJoined('[user.department]')
        .where('user.org_id', org_id)
        .where('acr.user_id', userId)
        .modify((qb) => {
          if (status) {
            qb.where('acr.status', status);
          }
          if (rangeFrom && rangeTo) {
            qb.whereBetween('acr.request_date', [rangeFrom, rangeTo]);
          }
        })
        .select('acr.*')
        .orderBy('acr.created_at', 'desc'),
    );

    const leaveRows = await LeaveRequest.query()
      .alias('lr')
      .leftJoin('users', 'users.id', 'lr.user_id')
      .leftJoin('leave_types', 'leave_types.id', 'lr.leave_type_id')
      .leftJoin('departments', 'departments.id', 'users.department_id')
      .where('lr.org_id', org_id)
      .where('lr.user_id', userId)
      .modify((qb) => {
        if (status) {
          qb.where('lr.status', status);
        }
        if (rangeFrom && rangeTo) {
          qb.where((inner) => {
            inner
              .whereBetween('lr.start_date', [rangeFrom, rangeTo])
              .orWhereBetween('lr.end_date', [rangeFrom, rangeTo])
              .orWhere((overlap) =>
                overlap.where('lr.start_date', '<=', rangeFrom).where('lr.end_date', '>=', rangeTo),
              );
          });
        }
      })
      .select(
        'lr.*',
        'leave_types.name as leave_type_name',
        'users.employee_id',
        'users.first_name',
        'users.last_name',
        'users.profile_image_url',
        'users.role',
        'users.designation',
        'users.department_id',
        'departments.name as department_name',
        'departments.working_days as department_working_days',
      )
      .orderBy('lr.created_at', 'desc');

    const {
      holidaySet: userCombinedHolidaySet,
      holidaySetByUserId: userCombinedHolidaySetByUserId,
      managedScheduleByManagerId: userCombinedManagedSchedule,
    } = await buildLeaveDaysContextForRows(org_id, leaveRows as any[]);

    const combined: any[] = [];

    const enrichedAttendanceRows = await enrichAttendanceRequestsWithOriginalPunchTimestamp(
      attendanceRows as any[],
    );

    const managerUserIdsForAttendance = attendanceRows
      .map((r: any) => (r as any).user)
      .filter((u: any) => u && u.role === 'manager')
      .map((u: any) => String(u.id));

    const managerDepartmentsMapForAttendance = await getManagedDepartmentSummaries(
      org_id,
      managerUserIdsForAttendance,
    );

    // For the target-user LEAVE rows, we can compute this manager's departments once.
    const managerDepartmentsForCurrentUser =
      targetUser.role === 'manager'
        ? ((await getManagedDepartmentSummaries(org_id, [String(userId)])).get(String(userId)) ??
          [])
        : [];

    const targetOverlapDepartmentIds = await resolveOverlapDepartmentIds(
      org_id,
      userId,
      (targetUser as any).role,
      (targetUser as any).department_id ?? null,
    );

    for (const attendanceEntry of enrichedAttendanceRows) {
      const row = attendanceEntry.row;
      const user = (row as any).user;

      let employeeSource: any = user;
      if (user && user.role === 'manager') {
        const managerId = String(user.id);
        const managerDepts = managerDepartmentsMapForAttendance.get(managerId) ?? [];
        employeeSource =
          managerDepts.length > 0 ? { ...user, manager_departments: managerDepts } : user;
      }

      combined.push({
        ...formatAttendanceRequestItem(row, {
          original_time: attendanceEntry.original_time,
          employee: buildEmployeeSummary(employeeSource),
        }),
        details: {
          request_date: row.request_date,
          wrong_punch_type: row.wrong_punch_type,
          corrected_time: row.corrected_time,
          original_time: attendanceEntry.original_time,
        },
      });
    }

    for (const row of leaveRows as any[]) {
      const approvedDepartmentTeammateOverlapCount =
        await calculateApprovedDepartmentTeammateOverlapCount({
          org_id,
          request_id: row.id,
          user_id: row.user_id,
          department_ids: targetOverlapDepartmentIds,
          start_date: row.start_date,
          end_date: row.end_date,
        });

      let leaveEmployeeSource: any = { ...row, id: row.user_id };
      if (row.role === 'manager') {
        // Prefer the manager's full department list (from DepartmentManager / legacy),
        // but if none is configured there, fall back to the row's own department_id/name.
        let managerDepts = managerDepartmentsForCurrentUser;

        if (!managerDepts || managerDepts.length === 0) {
          if (row.department_id && row.department_name) {
            managerDepts = [
              {
                id: String(row.department_id),
                name: String(row.department_name),
              },
            ];
          }
        }

        if (managerDepts && managerDepts.length > 0) {
          leaveEmployeeSource = { ...row, id: row.user_id, manager_departments: managerDepts };
        }
      }

      combined.push({
        request_type: 'LEAVE',
        id: row.id,
        employee: buildEmployeeSummary(leaveEmployeeSource),
        status: row.status,
        created_at: row.created_at,
        updated_at: row.updated_at ?? null,
        updated_by: row.updated_by ?? null,
        reason: row.reason ?? null,
        approver_comment: row.approver_comment ?? null,
        manager_status: row.manager_status ?? null,
        hr_status: row.hr_status ?? null,
        hr_id: row.hr_id ?? null,
        manager_action_at: row.manager_action_at ?? null,
        hr_action_at: row.hr_action_at ?? null,
        details: {
          start_date: row.start_date,
          end_date: row.end_date,
          leave_type_name: row.leave_type_name,
          teammate_overlap_count: approvedDepartmentTeammateOverlapCount,
        },
        record: {
          id: row.id,
          user_id: row.user_id,
          leave_type_id: row.leave_type_id ?? null,
          start_date: row.start_date,
          end_date: row.end_date,
          day_session: row.day_session ?? 'FULL',
          total_days: countLeaveDaysForRow({
            row,
            holidaySet: userCombinedHolidaySet,
            holidaySetByUserId: userCombinedHolidaySetByUserId,
            managedScheduleByManagerId: userCombinedManagedSchedule,
          }),
          status: row.status,
          reason: row.reason ?? null,
          attachment_url: row.attachment_url ?? null,
          approver_comment: row.approver_comment ?? null,
          manager_id: row.manager_id ?? null,
          manager_status: row.manager_status ?? null,
          hr_status: row.hr_status ?? null,
          hr_id: row.hr_id ?? null,
          manager_action_at: row.manager_action_at ?? null,
          hr_action_at: row.hr_action_at ?? null,
          created_at: row.created_at ?? null,
          updated_at: row.updated_at ?? null,
          updated_by: row.updated_by ?? null,
        },
      });
    }

    combined.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const total = combined.length;
    const total_pages = Math.max(1, Math.ceil(total / safeLimit));
    const pageIndex = Math.min(safePage, total_pages);
    const offset = (pageIndex - 1) * safeLimit;
    const paged = combined.slice(offset, offset + safeLimit);

    return res.json(buildPaginatedResponse(pageIndex, safeLimit, total, paged));
  }

  /**
   * Combined requests for current JWT user (attendance + leave only).
   * GET /api/users/requests/combined/my
   *
   * Note: path param userId is intentionally ignored; JWT user id is used.
   * Query params and response shape match listOrgCombinedForUser.
   */
  static async listCombinedForCurrentUserFromPath(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const userId = req.user.id;
    const org_id = req.user.org_id;
    const parsed = combinedRequestsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const safePage = parsed.data.page;
    const safeLimit = parsed.data.limit;
    const status = parsed.data.status;
    const rangeFrom = parsed.data.from_date ?? parsed.data.start_date;
    const rangeTo = parsed.data.to_date ?? parsed.data.end_date;

    const attendanceRows = await applyUserDepartmentGraphSelect(
      AttendanceCorrectionRequest.query()
        .alias('acr')
        .withGraphJoined('[user.department]')
        .where('user.org_id', org_id)
        .where('acr.user_id', userId)
        .modify((qb) => {
          if (status) {
            qb.where('acr.status', status);
          }
          if (rangeFrom && rangeTo) {
            qb.whereBetween('acr.request_date', [rangeFrom, rangeTo]);
          }
        })
        .select('acr.*')
        .orderBy('acr.created_at', 'desc'),
    );

    const leaveRows = await LeaveRequest.query()
      .alias('lr')
      .leftJoin('users', 'users.id', 'lr.user_id')
      .leftJoin('leave_types', 'leave_types.id', 'lr.leave_type_id')
      .leftJoin('departments', 'departments.id', 'users.department_id')
      .where('lr.org_id', org_id)
      .where('lr.user_id', userId)
      .modify((qb) => {
        if (status) {
          qb.where('lr.status', status);
        }
        if (rangeFrom && rangeTo) {
          qb.where((inner) => {
            inner
              .whereBetween('lr.start_date', [rangeFrom, rangeTo])
              .orWhereBetween('lr.end_date', [rangeFrom, rangeTo])
              .orWhere((overlap) =>
                overlap.where('lr.start_date', '<=', rangeFrom).where('lr.end_date', '>=', rangeTo),
              );
          });
        }
      })
      .select(
        'lr.*',
        'leave_types.name as leave_type_name',
        'users.employee_id',
        'users.first_name',
        'users.last_name',
        'users.profile_image_url',
        'users.role',
        'users.designation',
        'users.department_id',
        'departments.name as department_name',
        'departments.working_days as department_working_days',
      )
      .orderBy('lr.created_at', 'desc');

    const {
      holidaySet: userCombinedHolidaySet,
      holidaySetByUserId: userCombinedHolidaySetByUserId,
      managedScheduleByManagerId: userCombinedManagedSchedule,
    } = await buildLeaveDaysContextForRows(org_id, leaveRows as any[]);

    const combined: any[] = [];

    const enrichedAttendanceRows = await enrichAttendanceRequestsWithOriginalPunchTimestamp(
      attendanceRows as any[],
    );

    const managerUserIdsForAttendance = attendanceRows
      .map((r: any) => (r as any).user)
      .filter((u: any) => u && u.role === 'manager')
      .map((u: any) => String(u.id));

    const managerDepartmentsMapForAttendance = await getManagedDepartmentSummaries(
      org_id,
      managerUserIdsForAttendance,
    );

    // For the current-user LEAVE rows, we can compute this manager's departments once.
    const managerDepartmentsForCurrentUser =
      req.user.role === 'manager'
        ? ((await getManagedDepartmentSummaries(org_id, [String(userId)])).get(String(userId)) ??
          [])
        : [];

    const pathApplicant = await User.query()
      .findById(userId)
      .where('org_id', org_id)
      .select('role', 'department_id');
    const myCombinedOverlapDepartmentIds = await resolveOverlapDepartmentIds(
      org_id,
      userId,
      (pathApplicant as any)?.role ?? req.user.role,
      (pathApplicant as any)?.department_id ?? null,
    );

    for (const attendanceEntry of enrichedAttendanceRows) {
      const row = attendanceEntry.row;
      const user = (row as any).user;

      let employeeSource: any = user;
      if (user && user.role === 'manager') {
        const managerId = String(user.id);
        const managerDepts = managerDepartmentsMapForAttendance.get(managerId) ?? [];
        employeeSource =
          managerDepts.length > 0 ? { ...user, manager_departments: managerDepts } : user;
      }

      combined.push({
        ...formatAttendanceRequestItem(row, {
          original_time: attendanceEntry.original_time,
          employee: buildEmployeeSummary(employeeSource),
        }),
        details: {
          request_date: row.request_date,
          wrong_punch_type: row.wrong_punch_type,
          corrected_time: row.corrected_time,
          original_time: attendanceEntry.original_time,
        },
      });
    }

    for (const row of leaveRows as any[]) {
      const approvedDepartmentTeammateOverlapCount =
        await calculateApprovedDepartmentTeammateOverlapCount({
          org_id,
          request_id: row.id,
          user_id: row.user_id,
          department_ids: myCombinedOverlapDepartmentIds,
          start_date: row.start_date,
          end_date: row.end_date,
        });

      let leaveEmployeeSource: any = { ...row, id: row.user_id };
      if (row.role === 'manager') {
        // Prefer the manager's full department list (from DepartmentManager / legacy),
        // but if none is configured there, fall back to the row's own department_id/name.
        let managerDepts = managerDepartmentsForCurrentUser;

        if (!managerDepts || managerDepts.length === 0) {
          if (row.department_id && row.department_name) {
            managerDepts = [
              {
                id: String(row.department_id),
                name: String(row.department_name),
              },
            ];
          }
        }

        if (managerDepts && managerDepts.length > 0) {
          leaveEmployeeSource = { ...row, id: row.user_id, manager_departments: managerDepts };
        }
      }

      combined.push({
        request_type: 'LEAVE',
        id: row.id,
        employee: buildEmployeeSummary(leaveEmployeeSource),
        status: row.status,
        created_at: row.created_at,
        updated_at: row.updated_at ?? null,
        updated_by: row.updated_by ?? null,
        reason: row.reason ?? null,
        approver_comment: row.approver_comment ?? null,
        manager_status: row.manager_status ?? null,
        hr_status: row.hr_status ?? null,
        hr_id: row.hr_id ?? null,
        manager_action_at: row.manager_action_at ?? null,
        hr_action_at: row.hr_action_at ?? null,
        details: {
          start_date: row.start_date,
          end_date: row.end_date,
          leave_type_name: row.leave_type_name,
          teammate_overlap_count: approvedDepartmentTeammateOverlapCount,
        },
        record: {
          id: row.id,
          user_id: row.user_id,
          leave_type_id: row.leave_type_id ?? null,
          start_date: row.start_date,
          end_date: row.end_date,
          day_session: row.day_session ?? 'FULL',
          total_days: countLeaveDaysForRow({
            row,
            holidaySet: userCombinedHolidaySet,
            holidaySetByUserId: userCombinedHolidaySetByUserId,
            managedScheduleByManagerId: userCombinedManagedSchedule,
          }),
          status: row.status,
          reason: row.reason ?? null,
          attachment_url: row.attachment_url ?? null,
          approver_comment: row.approver_comment ?? null,
          manager_id: row.manager_id ?? null,
          manager_status: row.manager_status ?? null,
          hr_status: row.hr_status ?? null,
          hr_id: row.hr_id ?? null,
          manager_action_at: row.manager_action_at ?? null,
          hr_action_at: row.hr_action_at ?? null,
          created_at: row.created_at ?? null,
          updated_at: row.updated_at ?? null,
          updated_by: row.updated_by ?? null,
        },
      });
    }

    combined.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const total = combined.length;
    const total_pages = Math.max(1, Math.ceil(total / safeLimit));
    const pageIndex = Math.min(safePage, total_pages);
    const offset = (pageIndex - 1) * safeLimit;
    const paged = combined.slice(offset, offset + safeLimit);

    return res.json(buildPaginatedResponse(pageIndex, safeLimit, total, paged));
  }

  static async create(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = attendanceCorrectionCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { attendance_log_id, request_date, requested_clock_in, requested_clock_out, reason } =
      parsed.data;

    // Normalize attendance_log_id to string UUID (or null) to match the DB schema.
    const attendanceLogId =
      attendance_log_id !== undefined && attendance_log_id !== null
        ? String(attendance_log_id)
        : null;

    if (attendanceLogId) {
      const log = await AttendanceLog.query().findById(attendanceLogId);
      if (!log || log.user_id !== req.user.id || log.org_id !== req.user.org_id) {
        return res.status(400).json({ message: 'Invalid attendance_log_id' });
      }
    }

    const created = await AttendanceCorrectionRequest.query().insert({
      user_id: req.user.id,
      attendance_log_id: attendanceLogId,
      request_date,
      requested_clock_in,
      requested_clock_out,
      reason: reason ?? null,
      status: 'PENDING',
      updated_by: req.user.id,
    });

    await ActivityLogService.recordActivitySafely({
      org_id: req.user.org_id,
      actor_user_id: req.user.id,
      target_user_id: req.user.id,
      entity_type: ACTIVITY_ENTITY_TYPES.ATTENDANCE_REQUEST,
      entity_id: created.id,
      activity_type: ACTIVITY_TYPES.ATTENDANCE_REQUEST_CREATED,
      metadata: {
        request_date,
        status: created.status,
      },
    });

    return res.status(201).json(created);
  }

  // New UI flow: Regularize attendance by correcting a single punch time (with optional attachment)
  static async createRegularization(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = attendanceRegularizationCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const {
      request_date,
      wrong_punch_type,
      corrected_time,
      reason,
      attachment_url,
      break_corrections,
      requested_clock_in: bodyRequestedClockIn,
      requested_clock_out: bodyRequestedClockOut,
    } = parsed.data;

    // Check if employee is trying to regularize attendance before their joining date
    const user = await User.query().findById(req.user.id).where('org_id', req.user.org_id);
    if (user && user.date_of_joining) {
      const raw = user.date_of_joining as any;
      let joinDateStr: string | null = null;
      if (raw instanceof Date) {
        joinDateStr = formatDateLocal(raw);
      } else {
        // Assume YYYY-MM-DD string and trim defensively
        joinDateStr = String(raw).slice(0, 10);
      }

      if (joinDateStr && request_date < joinDateStr) {
        return res.status(400).json({
          message: 'Cannot regularize attendance before your joining date',
          date_of_joining: joinDateStr,
        });
      }
    }

    // Load the target attendance log for that date (if any)
    const log = (await AttendanceLog.query().findOne({
      org_id: req.user.org_id,
      user_id: req.user.id,
      date: request_date,
    })) as any;

    const correctedIso = buildIsoFromDateAndTimeLocal(request_date, corrected_time);
    if (!correctedIso) {
      return res.status(400).json({ message: 'Invalid corrected_time' });
    }

    // Derive full requested clock-in/out.
    // - If there is a completed attendance log for that date, we correct just one punch.
    // - If there is no completed log, we still allow employees to submit a regularization
    //   request with the simple payload (request_date, wrong_punch_type, corrected_time, ...).
    //   In that case, we may not be able to derive full requested_clock_in/out automatically,
    //   and approvers can handle attendance manually if needed.
    let requested_clock_in: string | null = null;
    let requested_clock_out: string | null = null;
    let attendance_log_id: string | null = null;

    if (log) {
      attendance_log_id = String((log as any).id);
    }

    const isClockType =
      wrong_punch_type === 'CLOCK_IN' ||
      wrong_punch_type === 'MISSING_IN' ||
      wrong_punch_type === 'WRONG_IN' ||
      wrong_punch_type === 'CLOCK_OUT' ||
      wrong_punch_type === 'MISSING_OUT' ||
      wrong_punch_type === 'WRONG_OUT';

    const hasCompletedLog = Boolean(log && log.clock_in_time && log.clock_out_time);
    const hasAnyLog = Boolean(log);

    if (hasCompletedLog) {
      // Existing completed log – keep prior behavior of correcting a single punch.
      requested_clock_in = log.clock_in_time ?? null;
      requested_clock_out = log.clock_out_time ?? null;

      // Handle both old and new enum values
      if (
        wrong_punch_type === 'CLOCK_IN' ||
        wrong_punch_type === 'MISSING_IN' ||
        wrong_punch_type === 'WRONG_IN'
      ) {
        requested_clock_in = correctedIso;
      } else if (
        wrong_punch_type === 'CLOCK_OUT' ||
        wrong_punch_type === 'MISSING_OUT' ||
        wrong_punch_type === 'WRONG_OUT'
      ) {
        requested_clock_out = correctedIso;

        // If clock-out is before or equal to clock-in, it might be meant for the next day
        // This can happen when someone clocks in late at night (e.g., 11:10 PM) and clocks out the next day (e.g., 6:10 PM next day)
        // Note: If clock-out is after clock-in on the same day (e.g., 9 AM to 10 AM), no adjustment is needed
        if (requested_clock_in) {
          const clockInDate = new Date(requested_clock_in);
          const clockOutDate = new Date(requested_clock_out);

          if (clockOutDate <= clockInDate) {
            // Add 24 hours to the corrected time (next day)
            // Example: Clock-in at 11:10 PM, corrected clock-out at 6:10 PM → becomes 6:10 PM next day
            const nextDayDate = new Date(clockOutDate.getTime() + 24 * 60 * 60 * 1000);
            requested_clock_out = nextDayDate.toISOString();
          }
          // If clockOutDate > clockInDate, no adjustment needed (e.g., 9 AM to 10 AM same day)
        }
      } else if (wrong_punch_type === 'BREAKS') {
        // For BREAKS we keep the existing clock-in/out, and only adjust the breaks list
        // at approval time using break_corrections.
      }
    } else if (hasAnyLog) {
      // There is an attendance_log row but it is not completed (missing either clock-in or clock-out).
      // Use whatever exists as the base and apply the corrected punch.
      requested_clock_in = log.clock_in_time ?? null;
      requested_clock_out = log.clock_out_time ?? null;

      if (
        wrong_punch_type === 'CLOCK_IN' ||
        wrong_punch_type === 'MISSING_IN' ||
        wrong_punch_type === 'WRONG_IN'
      ) {
        requested_clock_in = correctedIso;
      } else if (
        wrong_punch_type === 'CLOCK_OUT' ||
        wrong_punch_type === 'MISSING_OUT' ||
        wrong_punch_type === 'WRONG_OUT'
      ) {
        requested_clock_out = correctedIso;
      }
    } else {
      // No attendance log row at all for that date (employee did not log in).
      // For BREAKS we still require an existing completed log, because we need a base day to
      // attach breaks to.
      if (wrong_punch_type === 'BREAKS') {
        return res.status(400).json({
          message:
            'Regularization for BREAKS requires an existing attendance log with clock-in and clock-out times for the requested date.',
        });
      }

      // When there is no log at all:
      // - Allow CLOCK_IN-side regularization (employee forgot to punch in); we derive
      //   requested_clock_in from corrected_time so that approval can create an attendance_log.
      // - Disallow CLOCK_OUT-side only regularization, because there is no prior clock-in
      //   to pair with a clock-out for that day.
      if (isClockType) {
        const isInType =
          wrong_punch_type === 'CLOCK_IN' ||
          wrong_punch_type === 'MISSING_IN' ||
          wrong_punch_type === 'WRONG_IN';
        const isOutType =
          wrong_punch_type === 'CLOCK_OUT' ||
          wrong_punch_type === 'MISSING_OUT' ||
          wrong_punch_type === 'WRONG_OUT';

        if (isOutType) {
          return res.status(400).json({
            message:
              'Cannot create a CLOCK_OUT-only regularization for a date with no attendance log. Please submit a full correction with both clock-in and clock-out times.',
          });
        }

        if (isInType) {
          // Use the corrected time as the requested clock-in; requested_clock_out can remain null.
          requested_clock_in = correctedIso;
        }

        // If the client chooses to provide explicit requested_clock_in/out, honor them.
        if (bodyRequestedClockIn) {
          requested_clock_in = bodyRequestedClockIn;
        }
        if (bodyRequestedClockOut) {
          requested_clock_out = bodyRequestedClockOut;
        }
      }
    }

    // For flows backed by a completed log, we must have valid requested_clock_in/out.
    if (hasCompletedLog && (!requested_clock_in || !requested_clock_out)) {
      return res.status(400).json({
        message:
          'Cannot derive both requested_clock_in and requested_clock_out for this regularization. Please submit a full correction request with both times.',
      });
    }

    // Only validate derived work hours when we actually have both times.
    if (requested_clock_in && requested_clock_out) {
      const hours = calculateWorkHours(requested_clock_in, requested_clock_out);
      if (hours < 0) {
        const clockInDate = new Date(requested_clock_in);
        const clockOutDate = new Date(requested_clock_out);
        return res.status(400).json({
          message: 'Invalid requested clock times',
          details: {
            clock_in: requested_clock_in,
            clock_out: requested_clock_out,
            clock_in_local: clockInDate.toLocaleString(),
            clock_out_local: clockOutDate.toLocaleString(),
            error:
              clockOutDate <= clockInDate
                ? 'Clock out time must be after clock in time'
                : 'Invalid time format or calculation error',
          },
        });
      }
    }

    // Prevent duplicate regularization requests for the same user, date, and wrong_punch_type.
    // Employees can create at most one regularization per (date, wrong_punch_type),
    // but may create additional ones for other types on the same date.
    const existingSameType = await AttendanceCorrectionRequest.query()
      .where('user_id', req.user.id)
      .where('request_date', request_date)
      .where('wrong_punch_type', wrong_punch_type)
      .whereIn('status', ['PENDING', 'APPROVED'])
      .first();
    if (existingSameType) {
      return res.status(409).json({
        message:
          'A regularization request for this date and wrong_punch_type already exists. You can only create one per type per day.',
        request_id: existingSameType.id,
      });
    }

    // Prefer freshly uploaded attachment (via middleware) over raw URL in body.
    const attachmentFromUpload = (req as any).regularizationAttachment as
      | { url: string; key: string }
      | undefined;
    const finalAttachmentUrl = attachmentFromUpload?.url ?? attachment_url ?? null;

    const created = await AttendanceCorrectionRequest.query().insert({
      user_id: req.user.id,
      attendance_log_id,
      request_date,
      requested_clock_in,
      requested_clock_out,
      reason: reason ?? null,
      status: 'PENDING',

      wrong_punch_type,
      corrected_time,
      attachment_url: finalAttachmentUrl,
      break_corrections: wrong_punch_type === 'BREAKS' ? (break_corrections ?? null) : null,
      original_punch_time: resolveOriginalPunchTimestampByTypeFromTimes(
        wrong_punch_type,
        log
          ? {
              clock_in_time: (log as any).clock_in_time ?? null,
              clock_out_time: (log as any).clock_out_time ?? null,
            }
          : undefined,
      ),

      manager_status: 'PENDING',
      hr_status: 'PENDING',
      updated_by: req.user.id,
    } as any);

    await ActivityLogService.recordActivitySafely({
      org_id: req.user.org_id,
      actor_user_id: req.user.id,
      target_user_id: req.user.id,
      entity_type: ACTIVITY_ENTITY_TYPES.ATTENDANCE_REQUEST,
      entity_id: created.id,
      activity_type: ACTIVITY_TYPES.ATTENDANCE_REQUEST_CREATED,
      metadata: {
        request_date,
        wrong_punch_type,
        corrected_time,
        status: created.status,
      },
    });

    // Create linked helpdesk ticket for this attendance regularization (best-effort).
    try {
      const subject = `Attendance regularization: ${request_date}`.slice(0, 255);
      await HelpdeskTicket.query()
        .insert({
          org_id: req.user.org_id,
          created_by: req.user.id,
          category: 'attendance',
          subject,
          description: reason ?? 'Attendance regularization request',
          priority: 'MEDIUM',
          status: 'OPEN',
          resolution: 'PENDING',
          attendance_correction_request_id: (created as any).id,
          attachment_file_url: finalAttachmentUrl,
        } as any)
        .onConflict(['org_id', 'attendance_correction_request_id'])
        .ignore();
    } catch {
      // Backwards-compatible retry if DB constraint doesn't allow PENDING yet.
      try {
        const subject = `Attendance regularization: ${request_date}`.slice(0, 255);
        await HelpdeskTicket.query()
          .insert({
            org_id: req.user.org_id,
            created_by: req.user.id,
            category: 'attendance',
            subject,
            description: reason ?? 'Attendance regularization request',
            priority: 'MEDIUM',
            status: 'OPEN',
            attendance_correction_request_id: (created as any).id,
            attachment_file_url: finalAttachmentUrl,
          } as any)
          .onConflict(['org_id', 'attendance_correction_request_id'])
          .ignore();
      } catch (err) {
        logger.error(
          {
            err,
            org_id: req.user.org_id,
            user_id: req.user.id,
            attendance_correction_request_id: (created as any).id,
          },
          'Failed to create linked helpdesk ticket for attendance regularization',
        );
      }
    }

    return res.status(201).json(created);
  }

  // Helper API: return punches and breaks for a given date so the UI can populate wrong_punch_type options
  static async getRegularizationDetails(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = attendanceRegularizationDetailsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { request_date } = parsed.data;

    const log = await AttendanceLog.query()
      .where({
        org_id: req.user.org_id,
        user_id: req.user.id,
        date: request_date,
      })
      .first();

    if (!log) {
      return res.status(404).json({ message: 'No attendance log found for the requested date' });
    }

    const breaks = await AttendanceBreak.query()
      .where('attendance_log_id', log.id)
      .select('id', 'break_type', 'start_time', 'end_time');

    return res.json({
      request_date,
      has_clock_in: Boolean(log.clock_in_time),
      has_clock_out: Boolean(log.clock_out_time),
      clock_in_time: log.clock_in_time,
      clock_out_time: log.clock_out_time,
      breaks: breaks.map((b: any) => ({
        id: b.id,
        break_type: b.break_type,
        start_time: b.start_time,
        end_time: b.end_time,
      })),
    });
  }

  static async cancelRequest(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ message: 'request id is required' });
    }

    const request = await AttendanceCorrectionRequest.query().withGraphJoined('user').findById(id);

    if (!request) {
      return res.status(404).json({ message: 'Request not found' });
    }

    const requestUser = (request as AttendanceCorrectionRequest & { user?: User }).user;
    if (!requestUser || requestUser.org_id !== req.user.org_id) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const org_id = req.user.org_id;
    const user_id = req.user.id;
    const role = req.user.role;

    const allowed = await canCancelRequestForOwner({ id: user_id, org_id, role }, request.user_id);
    if (!allowed) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    if (request.status !== 'PENDING' && request.status !== 'APPROVED') {
      return res.status(400).json({
        message: 'Only pending or approved attendance requests can be cancelled',
      });
    }

    const cancelParsed = requestCancelBodySchema.safeParse(req.body ?? {});
    if (!cancelParsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: cancelParsed.error.flatten().fieldErrors,
      });
    }
    const { comment } = cancelParsed.data;

    const now = new Date();
    const cancelPatch: Record<string, unknown> = {
      status: 'CANCELLED',
      cancelled_at: now,
      cancelled_by: user_id,
      updated_at: now,
      updated_by: user_id,
    };
    if (comment !== undefined) {
      cancelPatch.approver_comment = comment ?? null;
    }

    const updated = await AttendanceCorrectionRequest.transaction(async (trx) => {
      try {
        await HelpdeskTicket.query(trx)
          .where('org_id', org_id)
          .where('attendance_correction_request_id', id)
          .patch({ status: 'RESOLVED', updated_at: now });
      } catch {
        // ignore helpdesk sync failures
      }
      return AttendanceCorrectionRequest.query(trx).patchAndFetchById(id, cancelPatch as any);
    });

    await ActivityLogService.recordActivitySafely({
      org_id,
      actor_user_id: user_id,
      target_user_id: request.user_id,
      entity_type: ACTIVITY_ENTITY_TYPES.ATTENDANCE_REQUEST,
      entity_id: id,
      activity_type: ACTIVITY_TYPES.ATTENDANCE_REQUEST_CANCELLED,
      metadata: {
        status: 'CANCELLED',
        comment: comment ?? null,
        request_date: request.request_date,
        wrong_punch_type: request.wrong_punch_type ?? null,
      },
    });

    const updatedJson =
      updated && typeof (updated as any).toJSON === 'function'
        ? (updated as any).toJSON()
        : updated;

    return res.json(updatedJson);
  }

  static async approve(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = attendanceCorrectionApproveSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { requestId, action, comment } = parsed.data;

    const request = await AttendanceCorrectionRequest.query()
      .withGraphJoined('user')
      .findById(requestId);

    if (!request) {
      return res.status(404).json({ message: 'Request not found' });
    }

    const requestUser = (request as AttendanceCorrectionRequest & { user?: any }).user;
    if (!requestUser || requestUser.org_id !== req.user.org_id) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    if (request.status !== 'PENDING') {
      return res.status(400).json({ message: 'Request already processed' });
    }

    const role = (req.user as any).role;
    const isManager = role === 'manager';
    const isHr = role === 'hr';
    const isAdmin = role === 'admin';

    // Managers and HRs must not approve/reject their own attendance requests
    if ((isManager || isHr) && String(request.user_id) === String(req.user.id)) {
      return res.status(403).json({ message: 'You cannot approve or reject your own request' });
    }

    // Manager step: approve -> move to HR pending; reject -> final reject
    if (isManager && !isAdmin) {
      if ((request as any).manager_status !== 'PENDING') {
        return res.status(400).json({ message: 'Manager already processed this request' });
      }

      if (action === 'REJECT') {
        const updated = await AttendanceCorrectionRequest.query()
          .patch({
            status: 'REJECTED',
            manager_status: 'REJECTED',
            manager_id: req.user.id,
            manager_action_at: new Date().toISOString(),
            approver_id: req.user.id,
            approver_comment: comment ?? null,
            updated_by: req.user.id,
          })
          .where('id', requestId)
          .returning('*');

        const updatedRow = Array.isArray(updated) ? updated[0] : updated;
        await ActivityLogService.recordActivitySafely({
          org_id: requestUser.org_id,
          actor_user_id: req.user.id,
          target_user_id: request.user_id,
          entity_type: ACTIVITY_ENTITY_TYPES.ATTENDANCE_REQUEST,
          entity_id: request.id,
          activity_type: ACTIVITY_TYPES.ATTENDANCE_REQUEST_REJECTED,
          metadata: {
            request_date: request.request_date,
            status: updatedRow?.status ?? 'REJECTED',
            comment: comment ?? null,
            manager_status: updatedRow?.manager_status ?? null,
            hr_status: updatedRow?.hr_status ?? null,
          },
        });

        return res.json(updatedRow);
      }
      // For APPROVE, fall through to the unified approval logic below so that
      // attendance logs are updated consistently regardless of approver role.
    }

    if (action === 'REJECT') {
      // Admin/HR/Manager can reject; set statuses based on role.
      const now = new Date().toISOString();
      const updated = await AttendanceCorrectionRequest.query()
        .patch({
          status: 'REJECTED',
          manager_status:
            isAdmin && (request as any).manager_status === 'PENDING'
              ? 'REJECTED'
              : isManager
                ? 'REJECTED'
                : ((request as any).manager_status ?? 'PENDING'),
          hr_status: isHr || isAdmin ? 'REJECTED' : ((request as any).hr_status ?? 'PENDING'),
          manager_id:
            (isAdmin && (request as any).manager_status === 'PENDING') || isManager
              ? req.user.id
              : ((request as any).manager_id ?? null),
          hr_id: isHr || isAdmin ? req.user.id : ((request as any).hr_id ?? null),
          manager_action_at:
            (isAdmin && (request as any).manager_status === 'PENDING') || isManager
              ? now
              : ((request as any).manager_action_at ?? null),
          hr_action_at: isHr || isAdmin ? now : ((request as any).hr_action_at ?? null),
          approver_id: req.user.id,
          approver_comment: comment ?? null,
          updated_by: req.user.id,
        })
        .where('id', requestId)
        .returning('*');

      const updatedRow = Array.isArray(updated) ? updated[0] : updated;
      await ActivityLogService.recordActivitySafely({
        org_id: requestUser.org_id,
        actor_user_id: req.user.id,
        target_user_id: request.user_id,
        entity_type: ACTIVITY_ENTITY_TYPES.ATTENDANCE_REQUEST,
        entity_id: request.id,
        activity_type: ACTIVITY_TYPES.ATTENDANCE_REQUEST_REJECTED,
        metadata: {
          request_date: request.request_date,
          status: updatedRow?.status ?? 'REJECTED',
          comment: comment ?? null,
          manager_status: updatedRow?.manager_status ?? null,
          hr_status: updatedRow?.hr_status ?? null,
        },
      });

      return res.json(updatedRow);
    }

    const hasRequestedIn = Boolean(request.requested_clock_in);
    const hasRequestedOut = Boolean(request.requested_clock_out);

    // If we don't have any times at all, just approve the request without touching logs.
    if (!hasRequestedIn && !hasRequestedOut) {
      const now = new Date().toISOString();
      const newManagerStatus =
        isAdmin && (request as any).manager_status === 'PENDING'
          ? 'APPROVED'
          : isManager
            ? 'APPROVED'
            : ((request as any).manager_status ?? 'PENDING');
      const newHrStatus = isHr || isAdmin ? 'APPROVED' : ((request as any).hr_status ?? 'PENDING');
      // Overall request status becomes APPROVED as soon as any approver (manager/HR/admin) approves.
      const finalStatus = 'APPROVED';

      const updatedNoTimes = await AttendanceCorrectionRequest.query()
        .patch({
          status: finalStatus,
          approver_id: req.user.id,
          manager_status: newManagerStatus,
          hr_status: newHrStatus,
          manager_id:
            (isAdmin && (request as any).manager_status === 'PENDING') || isManager
              ? req.user.id
              : ((request as any).manager_id ?? null),
          hr_id: isHr || isAdmin ? req.user.id : ((request as any).hr_id ?? null),
          manager_action_at:
            (isAdmin && (request as any).manager_status === 'PENDING') || isManager
              ? now
              : ((request as any).manager_action_at ?? null),
          hr_action_at: isHr || isAdmin ? now : ((request as any).hr_action_at ?? null),
          approver_comment: comment ?? null,
          updated_by: req.user.id,
        })
        .where('id', requestId)
        .returning('*');

      const updatedRow = Array.isArray(updatedNoTimes) ? updatedNoTimes[0] : updatedNoTimes;
      await ActivityLogService.recordActivitySafely({
        org_id: requestUser.org_id,
        actor_user_id: req.user.id,
        target_user_id: request.user_id,
        entity_type: ACTIVITY_ENTITY_TYPES.ATTENDANCE_REQUEST,
        entity_id: request.id,
        activity_type: ACTIVITY_TYPES.ATTENDANCE_REQUEST_APPROVED,
        metadata: {
          request_date: request.request_date,
          status: updatedRow?.status ?? 'APPROVED',
          comment: comment ?? null,
          manager_status: updatedRow?.manager_status ?? null,
          hr_status: updatedRow?.hr_status ?? null,
        },
      });

      return res.json(updatedRow);
    }

    let log: AttendanceLog | null = null;
    if (request.attendance_log_id) {
      log = (await AttendanceLog.query().findById(request.attendance_log_id)) ?? null;
    }
    if (!log) {
      log =
        (await AttendanceLog.query().findOne({
          user_id: request.user_id,
          date: request.request_date,
        })) ?? null;
    }

    const wrongTypeRaw = (request as any).wrong_punch_type as string | null | undefined;
    const wrongType = wrongTypeRaw ? String(wrongTypeRaw).toUpperCase() : null;

    let nextClockIn: string | null = log ? ((log as any).clock_in_time ?? null) : null;
    let nextClockOut: string | null = log ? ((log as any).clock_out_time ?? null) : null;

    if (wrongType === 'BREAKS') {
      // Punch times come only from the existing log; break_corrections block updates breaks.
    } else if (wrongType && CLOCK_IN_PUNCH_TYPES.has(wrongType)) {
      if (hasRequestedIn) {
        nextClockIn = request.requested_clock_in!;
      }
    } else if (wrongType && CLOCK_OUT_PUNCH_TYPES.has(wrongType)) {
      if (hasRequestedOut) {
        nextClockOut = request.requested_clock_out!;
      }
    } else {
      if (hasRequestedIn) {
        nextClockIn = request.requested_clock_in!;
      }
      if (hasRequestedOut) {
        nextClockOut = request.requested_clock_out!;
      }
    }

    let hours: number | null = null;
    if (nextClockIn && nextClockOut) {
      hours = calculateWorkHours(nextClockIn, nextClockOut);
      if (hours < 0) {
        return res.status(400).json({ message: 'Invalid requested clock times' });
      }
    }

    const patch: any = {
      status: 'PRESENT',
    };
    if (log) {
      const prevIn = (log as any).clock_in_time ?? null;
      const prevOut = (log as any).clock_out_time ?? null;
      if (nextClockIn !== prevIn) {
        patch.clock_in_time = nextClockIn;
      }
      if (nextClockOut !== prevOut) {
        patch.clock_out_time = nextClockOut;
      }
    } else {
      patch.clock_in_time = nextClockIn;
      patch.clock_out_time = nextClockOut;
    }
    if (hours !== null) {
      patch.total_work_hours = hours;
    }

    if (log) {
      await AttendanceLog.query()
        .patch(patch)
        .where('id', (log as any).id);
    } else {
      log = await AttendanceLog.query()
        .insert({
          org_id: requestUser.org_id,
          user_id: request.user_id,
          date: request.request_date,
          ...patch,
        })
        .returning('*');
    }

    // If this is a BREAKS-type regularization with break_corrections,
    // rewrite the day's break list to match the corrected values.
    if (
      request.wrong_punch_type === 'BREAKS' &&
      Array.isArray((request as any).break_corrections) &&
      (request as any).break_corrections.length > 0 &&
      log
    ) {
      const corrections = (request as any).break_corrections as Array<{
        break_type: 'LUNCH' | 'TEA';
        corrected_start_time: string;
        corrected_end_time: string;
      }>;

      // Remove existing breaks for that log
      await AttendanceBreak.query().delete().where('attendance_log_id', log.id);

      // Insert corrected breaks
      for (const bc of corrections) {
        const startIso = buildIsoFromDateAndTimeLocal(
          request.request_date,
          bc.corrected_start_time,
        );
        const endIso = buildIsoFromDateAndTimeLocal(request.request_date, bc.corrected_end_time);

        if (!startIso || !endIso) {
          // Skip invalid entries; main approval has already succeeded
          // and we don't want to fail the whole transaction for one bad break.
          // (In practice, UI + schema should prevent this.)

          continue;
        }

        await AttendanceBreak.query().insert({
          attendance_log_id: log.id,
          break_type: bc.break_type,
          start_time: startIso,
          end_time: endIso,
        } as any);
      }
    }

    const attendanceLogId =
      log && (log as any).id !== undefined ? String((log as any).id) : request.attendance_log_id;

    const now = new Date().toISOString();
    // Admin/HR/Manager approval – update statuses based on role.
    const newManagerStatus =
      isAdmin && (request as any).manager_status === 'PENDING'
        ? 'APPROVED'
        : isManager
          ? 'APPROVED'
          : ((request as any).manager_status ?? 'PENDING');
    const newHrStatus = isHr || isAdmin ? 'APPROVED' : ((request as any).hr_status ?? 'PENDING');
    // Overall request status becomes APPROVED as soon as any approver (manager/HR/admin) approves.
    const finalStatus = 'APPROVED';

    const updated = await AttendanceCorrectionRequest.query()
      .patch({
        status: finalStatus,
        approver_id: req.user.id,
        attendance_log_id: attendanceLogId ?? null,
        manager_status: newManagerStatus,
        hr_status: newHrStatus,
        manager_id:
          (isAdmin && (request as any).manager_status === 'PENDING') || isManager
            ? req.user.id
            : ((request as any).manager_id ?? null),
        hr_id: isHr || isAdmin ? req.user.id : ((request as any).hr_id ?? null),
        manager_action_at:
          (isAdmin && (request as any).manager_status === 'PENDING') || isManager
            ? now
            : ((request as any).manager_action_at ?? null),
        hr_action_at: isHr || isAdmin ? now : ((request as any).hr_action_at ?? null),
        approver_comment: comment ?? null,
        updated_by: req.user.id,
      } as any)
      .where('id', requestId)
      .returning('*');
    const updatedRow = Array.isArray(updated) ? updated[0] : updated;
    await ActivityLogService.recordActivitySafely({
      org_id: requestUser.org_id,
      actor_user_id: req.user.id,
      target_user_id: request.user_id,
      entity_type: ACTIVITY_ENTITY_TYPES.ATTENDANCE_REQUEST,
      entity_id: request.id,
      activity_type: ACTIVITY_TYPES.ATTENDANCE_REQUEST_APPROVED,
      metadata: {
        request_date: request.request_date,
        status: updatedRow?.status ?? 'APPROVED',
        comment: comment ?? null,
        manager_status: updatedRow?.manager_status ?? null,
        hr_status: updatedRow?.hr_status ?? null,
      },
    });

    return res.json(updatedRow);
  }

  // REST-ier status update endpoint: PATCH /attendance/requests/:id/status
  static async updateStatus(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ message: 'request id is required' });
    }

    const parsed = attendanceCorrectionStatusUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { status, comment } = parsed.data;
    if (status === 'CANCELLED') {
      return AttendanceRequestController.cancelRequest(req, res);
    }

    const role = req.user.role;
    if (!['admin', 'hr', 'manager'].includes(role)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    // Map desired status to legacy action values expected by approve()
    const action = status === 'REJECTED' ? 'REJECT' : 'APPROVE';

    // Reuse existing approval logic by adapting the request body
    (req as any).body = {
      requestId: id,
      action,
      comment,
    };

    return AttendanceRequestController.approve(req, res);
  }
}
