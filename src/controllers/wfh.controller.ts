import type { Request, Response } from 'express';

import { WfhRequest } from '../models/WfhRequest';
import { LeaveRequest } from '../models/LeaveRequest';
import { User } from '../models/User';
import {
  wfhApplySchema,
  wfhApproveSchema,
  wfhMyListQuerySchema,
  wfhOrgListQuerySchema,
  wfhStatusUpdateSchema,
  updateWfhRequestSchema,
  requestCancelBodySchema,
} from '../validators';
import {
  canCancelRequestForOwner,
  fetchPrimaryManagedDepartmentScheduleByManagerIds,
  getManagedDepartmentIds,
  getManagedDepartmentSummaries,
} from '../utils/department-manager.utils';
import {
  buildLeaveDaysContextForRows,
  countLeaveDaysForRow,
  countLeaveDaysInRange,
  resolveLeaveScheduleForRow,
} from '../utils/leave.utils';
import { applyDateRangeOverlapFilter } from '../utils/wfh.utils';
import { logger } from '../config/logger';
import {
  ACTIVITY_ENTITY_TYPES,
  ACTIVITY_TYPES,
  ActivityLogService,
} from '../services/activity-log.service';
import {
  notifyWfhCancelled,
  notifyWfhStatusChanged,
  notifyWfhSubmitted,
} from '../services/notifications/wfh-notification.service';
import { buildEmployeeSummary } from '../utils/employee-summary.utils';

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

export const formatWfhRequestItem = (
  row: any,
  options?: {
    employee?: any;
    total_days?: number | null;
  },
) => ({
  id: row.id,
  request_type: 'WFH',
  status: row.status,
  created_at: row.created_at ?? null,
  updated_at: row.updated_at ?? null,
  updated_by: row.updated_by ?? null,
  employee: options?.employee ?? null,
  start_date: row.start_date ?? null,
  end_date: row.end_date ?? null,
  total_days: options?.total_days !== undefined ? options.total_days : (row.total_days ?? null),
  reason: row.reason ?? null,
  attachment_url: row.attachment_url ?? null,
  approver_comment: row.approver_comment ?? null,
  manager_id: row.manager_id ?? null,
  manager_status: row.manager_status ?? null,
  hr_status: row.hr_status ?? null,
  hr_id: row.hr_id ?? null,
  manager_action_at: row.manager_action_at ?? null,
  hr_action_at: row.hr_action_at ?? null,
  details: {
    start_date: row.start_date ?? null,
    end_date: row.end_date ?? null,
  },
  record: {
    id: row.id,
    user_id: row.user_id,
    start_date: row.start_date,
    end_date: row.end_date,
    total_days: options?.total_days !== undefined ? options.total_days : (row.total_days ?? null),
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

async function assertNoWfhOrLeaveOverlap(params: {
  org_id: string;
  user_id: string;
  start_date: string;
  end_date: string;
  excludeWfhId?: string;
}): Promise<{ ok: true } | { ok: false; status: number; body: any }> {
  const { org_id, user_id, start_date, end_date, excludeWfhId } = params;

  let wfhQuery = WfhRequest.query()
    .where('org_id', org_id)
    .where('user_id', user_id)
    .whereIn('status', ['PENDING', 'APPROVED'])
    .where((qb) => {
      applyDateRangeOverlapFilter(qb as any, start_date, end_date);
    });
  if (excludeWfhId) {
    wfhQuery = wfhQuery.whereNot('id', excludeWfhId);
  }
  const overlappingWfh = await wfhQuery;
  if (overlappingWfh.length > 0) {
    return {
      ok: false,
      status: 409,
      body: {
        message: 'WFH dates overlap with an existing WFH request',
        conflict_request_ids: overlappingWfh.map((r) => r.id),
      },
    };
  }

  const overlappingLeave = await LeaveRequest.query()
    .where('org_id', org_id)
    .where('user_id', user_id)
    .where('status', 'APPROVED')
    .where((qb) => {
      applyDateRangeOverlapFilter(qb as any, start_date, end_date);
    });

  // FULL leave always blocks; half-day leave also blocks full-day WFH for that date.
  if (overlappingLeave.length > 0) {
    return {
      ok: false,
      status: 409,
      body: {
        message: 'WFH dates overlap with an approved leave request',
        conflict_request_ids: overlappingLeave.map((r) => r.id),
      },
    };
  }

  return { ok: true };
}

export class WfhController {
  static async applyWfh(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = wfhApplySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { start_date, end_date, reason, attachment_url } = parsed.data;
    const uploadedAttachment = (req as any).wfhAttachment as
      | { url?: string; key?: string }
      | undefined;
    const finalAttachmentUrl = uploadedAttachment?.url ?? attachment_url ?? null;
    const org_id = req.user.org_id;
    const user_id = req.user.id;

    const applicantRow = await User.query()
      .alias('u')
      .leftJoin('departments as d', 'd.id', 'u.department_id')
      .where('u.id', user_id)
      .where('u.org_id', org_id)
      .select('u.id', 'u.role', 'u.department_id', 'd.working_days as department_working_days')
      .first();

    const managedScheduleByManagerId =
      applicantRow?.role === 'manager'
        ? await fetchPrimaryManagedDepartmentScheduleByManagerIds(org_id, [user_id])
        : new Map();

    const applicantSchedule = resolveLeaveScheduleForRow(
      {
        role: applicantRow?.role,
        department_id: applicantRow?.department_id,
        department_working_days: (applicantRow as any)?.department_working_days,
        user_id,
      },
      managedScheduleByManagerId,
    );

    const countedDays = await countLeaveDaysInRange({
      org_id,
      startDate: start_date,
      endDate: end_date,
      departmentId: applicantSchedule.departmentId,
      workingDays: applicantSchedule.workingDays,
      userId: user_id,
    });

    // Same calendar day is always valid (even weekends/holidays); multi-day ranges still need working days.
    const totalDays = start_date === end_date ? Math.max(1, countedDays) : countedDays;

    if (totalDays <= 0) {
      return res.status(400).json({ message: 'Invalid date range' });
    }

    const overlap = await assertNoWfhOrLeaveOverlap({
      org_id,
      user_id,
      start_date,
      end_date,
    });
    if (!overlap.ok) {
      return res.status(overlap.status).json(overlap.body);
    }

    const manager_id = (req.user as any).manager_id ?? null;

    const created = await WfhRequest.query().insert({
      org_id,
      user_id,
      manager_id,
      start_date,
      end_date,
      reason,
      status: 'PENDING',
      total_days: totalDays,
      attachment_url: finalAttachmentUrl,
      updated_by: user_id,
    } as any);

    try {
      await notifyWfhSubmitted({
        orgId: org_id,
        wfhRequestId: created.id,
        applicantUserId: user_id,
        managerId: manager_id,
        startDate: start_date,
        endDate: end_date,
      });
    } catch (err) {
      logger.error(
        { err, org_id, wfhRequestId: created.id, employeeUserId: user_id },
        'Failed to send wfh-submitted notification',
      );
    }

    await ActivityLogService.recordActivitySafely({
      org_id,
      actor_user_id: user_id,
      target_user_id: user_id,
      entity_type: ACTIVITY_ENTITY_TYPES.WFH_REQUEST,
      entity_id: created.id,
      activity_type: ACTIVITY_TYPES.WFH_APPLIED,
      metadata: {
        start_date,
        end_date,
        total_days: totalDays,
        status: 'PENDING',
      },
    });

    const createdJson =
      created && typeof (created as any).toJSON === 'function'
        ? (created as any).toJSON()
        : created;

    return res.status(201).json({ ...createdJson, total_days: totalDays });
  }

  static async getWfhRequestById(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    const org_id = req.user.org_id;
    const user_id = req.user.id;
    const role = req.user.role;

    const request = await WfhRequest.query()
      .alias('wr')
      .leftJoin('users', 'users.id', 'wr.user_id')
      .leftJoin('departments', 'departments.id', 'users.department_id')
      .where('wr.id', id)
      .select(
        'wr.*',
        'users.employee_id',
        'users.first_name',
        'users.last_name',
        'users.profile_image_url',
        'users.role',
        'users.designation',
        'departments.id as department_id',
        'departments.name as department_name',
        'departments.working_days as department_working_days',
      )
      .first();

    if (!request) {
      return res.status(404).json({ message: 'WFH request not found' });
    }
    if (request.org_id !== org_id) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const isPrivileged = role === 'admin' || role === 'hr' || role === 'manager';
    if (!isPrivileged && request.user_id !== user_id) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const scheduleRow = {
      role: (request as any).role,
      department_id: (request as any).department_id,
      department_working_days: (request as any).department_working_days,
      user_id: request.user_id,
      start_date: request.start_date,
      end_date: request.end_date,
    };
    const managedSchedule =
      (request as any).role === 'manager'
        ? await fetchPrimaryManagedDepartmentScheduleByManagerIds(org_id, [request.user_id])
        : new Map();
    const { holidaySet, holidaySetByUserId } = await buildLeaveDaysContextForRows(org_id, [
      scheduleRow,
    ]);
    const computedTotalDays = countLeaveDaysForRow({
      row: scheduleRow,
      holidaySet,
      holidaySetByUserId,
      managedScheduleByManagerId: managedSchedule,
    });

    const employee = buildEmployeeSummary({
      ...(request as any),
      id: request.user_id,
    });

    return res.json(
      buildPaginatedResponse(1, 1, 1, [
        formatWfhRequestItem(request, { employee, total_days: computedTotalDays }),
      ]),
    );
  }

  static async updateWfhRequest(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    const org_id = req.user.org_id;
    const user_id = req.user.id;

    const parsed = updateWfhRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const request = await WfhRequest.query().findById(id);
    if (!request) {
      return res.status(404).json({ message: 'WFH request not found' });
    }
    if (request.org_id !== org_id) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (request.user_id !== user_id) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (request.status !== 'PENDING') {
      return res.status(400).json({ message: 'Only pending WFH requests can be updated' });
    }

    const start_date = parsed.data.start_date ?? String(request.start_date).slice(0, 10);
    const end_date = parsed.data.end_date ?? String(request.end_date).slice(0, 10);
    const reason = parsed.data.reason ?? request.reason;
    const { attachment_url } = parsed.data;
    const uploadedAttachment = (req as any).wfhAttachment as
      | { url?: string; key?: string }
      | undefined;

    if (start_date > end_date) {
      return res.status(400).json({ message: 'start_date must be before or equal to end_date' });
    }

    const applicantRow = await User.query()
      .alias('u')
      .leftJoin('departments as d', 'd.id', 'u.department_id')
      .where('u.id', user_id)
      .where('u.org_id', org_id)
      .select('u.id', 'u.role', 'u.department_id', 'd.working_days as department_working_days')
      .first();

    const managedScheduleByManagerId =
      applicantRow?.role === 'manager'
        ? await fetchPrimaryManagedDepartmentScheduleByManagerIds(org_id, [user_id])
        : new Map();
    const applicantSchedule = resolveLeaveScheduleForRow(
      {
        role: applicantRow?.role,
        department_id: applicantRow?.department_id,
        department_working_days: (applicantRow as any)?.department_working_days,
        user_id,
      },
      managedScheduleByManagerId,
    );

    const countedDays = await countLeaveDaysInRange({
      org_id,
      startDate: start_date,
      endDate: end_date,
      departmentId: applicantSchedule.departmentId,
      workingDays: applicantSchedule.workingDays,
      userId: user_id,
    });
    // Same calendar day is always valid (even weekends/holidays); multi-day ranges still need working days.
    const totalDays = start_date === end_date ? Math.max(1, countedDays) : countedDays;
    if (totalDays <= 0) {
      return res.status(400).json({ message: 'Invalid date range' });
    }

    const overlap = await assertNoWfhOrLeaveOverlap({
      org_id,
      user_id,
      start_date,
      end_date,
      excludeWfhId: id,
    });
    if (!overlap.ok) {
      return res.status(overlap.status).json(overlap.body);
    }

    const updateData: Record<string, unknown> = {
      start_date,
      end_date,
      reason,
      total_days: totalDays,
      updated_at: new Date(),
      updated_by: user_id,
    };
    const finalAttachmentUrl =
      uploadedAttachment?.url ?? (attachment_url !== undefined ? attachment_url : undefined);
    if (finalAttachmentUrl !== undefined) {
      updateData.attachment_url = finalAttachmentUrl;
    }

    const updated = await WfhRequest.query().patchAndFetchById(id, updateData as any);

    return res.json({ ...updated, total_days: totalDays });
  }

  static async cancelWfhRequest(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    const org_id = req.user.org_id;
    const user_id = req.user.id;
    const role = req.user.role;

    const request = await WfhRequest.query().findById(id);
    if (!request) {
      return res.status(404).json({ message: 'WFH request not found' });
    }
    if (request.org_id !== org_id) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const isOwner = request.user_id === user_id;
    const allowed = await canCancelRequestForOwner({ id: user_id, org_id, role }, request.user_id);
    if (!allowed) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    if (request.status !== 'PENDING' && request.status !== 'APPROVED') {
      return res.status(400).json({
        message: 'Only pending or approved WFH requests can be cancelled',
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

    const updated = await WfhRequest.query().patchAndFetchById(id, cancelPatch as any);

    await ActivityLogService.recordActivitySafely({
      org_id,
      actor_user_id: user_id,
      target_user_id: request.user_id,
      entity_type: ACTIVITY_ENTITY_TYPES.WFH_REQUEST,
      entity_id: id,
      activity_type: ACTIVITY_TYPES.WFH_CANCELLED,
      metadata: {
        status: 'CANCELLED',
        comment: comment ?? null,
        start_date: request.start_date,
        end_date: request.end_date,
      },
    });

    if (!isOwner) {
      try {
        await notifyWfhCancelled({
          orgId: org_id,
          wfhRequestId: id,
          employeeUserId: request.user_id,
          startDate: String(request.start_date).slice(0, 10),
          endDate: String(request.end_date).slice(0, 10),
        });
      } catch (err) {
        logger.warn({ err, wfhRequestId: id }, 'Failed to send wfh cancelled notification');
      }
    }

    return res.json(updated);
  }

  static async listMyRequests(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = wfhMyListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { page, limit, status, start_date, end_date } = parsed.data;
    const org_id = req.user.org_id;
    const user_id = req.user.id;

    const currentUser = await User.query()
      .alias('u')
      .leftJoin('departments as d', 'd.id', 'u.department_id')
      .where('u.org_id', org_id)
      .where('u.id', user_id)
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
        'd.working_days as department_working_days',
      )
      .first();

    const baseQuery = WfhRequest.query()
      .alias('wr')
      .where('wr.org_id', org_id)
      .where('wr.user_id', user_id);

    if (status) baseQuery.where('wr.status', status);
    if (start_date && end_date) {
      baseQuery.whereBetween('wr.start_date', [start_date, end_date]);
    }

    const countQuery = baseQuery.clone();
    const totalRow = await countQuery.countDistinct('wr.id as count').first();
    const total = Number((totalRow as { count?: string | number } | undefined)?.count ?? 0);
    const total_pages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(Math.max(page, 1), total_pages);
    const offset = (safePage - 1) * limit;

    const rows = await baseQuery
      .clone()
      .select('wr.*')
      .orderBy('wr.created_at', 'desc')
      .limit(limit)
      .offset(offset);

    const myScheduleRow = {
      role: currentUser?.role,
      department_id: currentUser?.department_id,
      department_working_days: (currentUser as any)?.department_working_days,
      user_id,
    };
    const myManagedSchedule =
      currentUser?.role === 'manager'
        ? await fetchPrimaryManagedDepartmentScheduleByManagerIds(org_id, [user_id])
        : new Map();
    const { holidaySet: myHolidaySet, holidaySetByUserId: myHolidaySetByUserId } =
      await buildLeaveDaysContextForRows(org_id, [
        ...rows.map((r: any) => ({
          ...myScheduleRow,
          start_date: r.start_date,
          end_date: r.end_date,
        })),
      ]);

    const items = rows.map((row: any) => {
      const computedTotalDays = countLeaveDaysForRow({
        row: {
          ...myScheduleRow,
          start_date: row.start_date,
          end_date: row.end_date,
        },
        holidaySet: myHolidaySet,
        holidaySetByUserId: myHolidaySetByUserId,
        managedScheduleByManagerId: myManagedSchedule,
      });
      return formatWfhRequestItem(row, {
        employee: currentUser ? buildEmployeeSummary(currentUser) : null,
        total_days: computedTotalDays,
      });
    });

    return res.json(buildPaginatedResponse(safePage, limit, total, items));
  }

  static async listOrgRequests(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = wfhOrgListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const {
      page,
      limit,
      status,
      employee_id,
      department_id,
      search,
      start_date,
      end_date,
      from_date,
      to_date,
    } = parsed.data;
    const rangeFrom = from_date ?? start_date;
    const rangeTo = to_date ?? end_date;

    const org_id = req.user.org_id;
    const isManager = req.user.role === 'manager';
    const isHr = req.user.role === 'hr';
    let managedDepartmentIds: string[] = [];
    if (isManager) {
      managedDepartmentIds = await getManagedDepartmentIds(org_id, req.user.id);
    }

    const baseQuery = WfhRequest.query()
      .alias('wr')
      .leftJoin('users', 'users.id', 'wr.user_id')
      .leftJoin('departments', 'departments.id', 'users.department_id')
      .where('wr.org_id', org_id)
      .modify((qb) => {
        if (isManager) {
          qb.whereIn('users.department_id', managedDepartmentIds).where('users.role', 'employee');
        }
        if (isManager || isHr) {
          qb.whereNot('wr.user_id', req.user!.id);
        }
      });

    if (status) baseQuery.where('wr.status', status);
    if (employee_id) baseQuery.where('wr.user_id', employee_id);
    if (department_id) baseQuery.where('users.department_id', department_id);
    if (rangeFrom && rangeTo) {
      baseQuery.where((qb) => {
        applyDateRangeOverlapFilter(qb as any, rangeFrom, rangeTo, 'wr.start_date', 'wr.end_date');
      });
    }
    if (search) {
      const term = `%${search}%`;
      baseQuery.where((b) => {
        b.where('users.employee_id', 'ilike', term)
          .orWhere('users.first_name', 'ilike', term)
          .orWhere('users.last_name', 'ilike', term)
          .orWhere('users.official_email', 'ilike', term)
          .orWhere('departments.name', 'ilike', term);
      });
    }

    const totalRow = await baseQuery.clone().countDistinct('wr.id as count').first();
    const total = Number((totalRow as { count?: string | number } | undefined)?.count ?? 0);
    const total_pages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(Math.max(page, 1), total_pages);
    const offset = (safePage - 1) * limit;

    const rows = await baseQuery
      .clone()
      .select(
        'wr.*',
        'users.employee_id',
        'users.first_name',
        'users.last_name',
        'users.profile_image_url',
        'users.role',
        'users.designation',
        'users.date_of_joining',
        'departments.id as department_id',
        'departments.name as department_name',
        'departments.working_days as department_working_days',
      )
      .orderBy('wr.created_at', 'desc')
      .limit(limit)
      .offset(offset);

    const managerUserIds = (rows as any[])
      .filter((row: any) => row.role === 'manager')
      .map((row: any) => String(row.user_id));
    const managerDepartmentsMap = await getManagedDepartmentSummaries(org_id, managerUserIds);
    const { holidaySet, holidaySetByUserId, managedScheduleByManagerId } =
      await buildLeaveDaysContextForRows(org_id, rows as any[]);

    const items = (rows as any[]).map((row) => {
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

      const employeeSource = manager_departments
        ? { ...row, id: row.user_id, manager_departments }
        : { ...row, id: row.user_id };

      const computedTotalDays = countLeaveDaysForRow({
        row,
        holidaySet,
        holidaySetByUserId,
        managedScheduleByManagerId,
      });

      return formatWfhRequestItem(row, {
        employee: buildEmployeeSummary(employeeSource),
        total_days: computedTotalDays,
      });
    });

    return res.json(buildPaginatedResponse(safePage, limit, total, items));
  }

  /**
   * Org-level WFH requests for a specific employee (admin/hr/manager view).
   * GET /api/users/:userId/wfh/requests
   */
  static async listOrgRequestsForUser(req: Request, res: Response): Promise<Response> {
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

    const parsed = wfhOrgListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { page, limit, status, start_date, end_date, from_date, to_date } = parsed.data;
    const rangeFrom = from_date ?? start_date;
    const rangeTo = to_date ?? end_date;
    const org_id = req.user.org_id;

    const baseQuery = WfhRequest.query()
      .alias('wr')
      .leftJoin('users', 'users.id', 'wr.user_id')
      .leftJoin('departments', 'departments.id', 'users.department_id')
      .where('wr.org_id', org_id)
      .where('wr.user_id', userId);

    if (status) baseQuery.where('wr.status', status);
    if (rangeFrom && rangeTo) {
      baseQuery.where((qb) => {
        applyDateRangeOverlapFilter(qb as any, rangeFrom, rangeTo, 'wr.start_date', 'wr.end_date');
      });
    }

    const totalRow = await baseQuery.clone().countDistinct('wr.id as count').first();
    const total = Number((totalRow as { count?: string | number } | undefined)?.count ?? 0);
    const total_pages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(Math.max(page, 1), total_pages);
    const offset = (safePage - 1) * limit;

    const rows = await baseQuery
      .clone()
      .select(
        'wr.*',
        'users.employee_id',
        'users.first_name',
        'users.last_name',
        'users.profile_image_url',
        'users.role',
        'users.designation',
        'users.date_of_joining',
        'departments.id as department_id',
        'departments.name as department_name',
        'departments.working_days as department_working_days',
      )
      .orderBy('wr.created_at', 'desc')
      .limit(limit)
      .offset(offset);

    const managerDepartmentsForTarget =
      targetUser.role === 'manager'
        ? ((await getManagedDepartmentSummaries(org_id, [userId])).get(userId) ?? [])
        : [];

    const { holidaySet, holidaySetByUserId, managedScheduleByManagerId } =
      await buildLeaveDaysContextForRows(org_id, rows as any[]);

    const items = (rows as any[]).map((row) => {
      let manager_departments: Array<{ id: string; name: string }> | undefined;
      if (row.role === 'manager') {
        manager_departments = [...managerDepartmentsForTarget];
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

      const employeeSource = manager_departments
        ? { ...row, id: row.user_id, manager_departments }
        : { ...row, id: row.user_id };

      const computedTotalDays = countLeaveDaysForRow({
        row,
        holidaySet,
        holidaySetByUserId,
        managedScheduleByManagerId,
      });

      return formatWfhRequestItem(row, {
        employee: buildEmployeeSummary(employeeSource),
        total_days: computedTotalDays,
      });
    });

    return res.json(buildPaginatedResponse(safePage, limit, total, items));
  }

  static async approveRequest(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = wfhApproveSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { requestId, action, comment } = parsed.data;

    const request = await WfhRequest.query().findById(requestId);
    if (!request) {
      return res.status(404).json({ message: 'Request not found' });
    }
    if (request.org_id !== req.user.org_id) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (request.status !== 'PENDING') {
      return res.status(400).json({ message: 'Request already processed' });
    }

    const role = (req.user as any).role;
    const isManager = role === 'manager';
    const isHr = role === 'hr';
    const isAdmin = role === 'admin';

    if ((isManager || isHr) && String(request.user_id) === String(req.user.id)) {
      return res.status(403).json({ message: 'You cannot approve or reject your own request' });
    }

    const notifyStatus = async (status: 'APPROVED' | 'REJECTED') => {
      try {
        await notifyWfhStatusChanged({
          orgId: request.org_id,
          wfhRequestId: request.id,
          employeeUserId: request.user_id,
          startDate: request.start_date,
          endDate: request.end_date,
          status,
        });
      } catch (err) {
        logger.error(
          {
            err,
            org_id: request.org_id,
            wfhRequestId: request.id,
            employeeUserId: request.user_id,
          },
          `Failed to send wfh-${status.toLowerCase()} notification`,
        );
      }
    };

    if (isManager && !isAdmin) {
      if ((request as any).manager_status !== 'PENDING') {
        return res.status(400).json({ message: 'Manager already processed this request' });
      }

      if (action === 'REJECT') {
        const updated = await WfhRequest.query()
          .patch({
            status: 'REJECTED',
            manager_status: 'REJECTED',
            manager_id: req.user.id,
            manager_action_at: new Date().toISOString(),
            approver_comment: comment ?? null,
            updated_by: req.user.id,
          } as any)
          .where('id', requestId)
          .returning('*');
        const updatedRow = Array.isArray(updated) ? updated[0] : updated;
        await notifyStatus('REJECTED');
        await ActivityLogService.recordActivitySafely({
          org_id: request.org_id,
          actor_user_id: req.user.id,
          target_user_id: request.user_id,
          entity_type: ACTIVITY_ENTITY_TYPES.WFH_REQUEST,
          entity_id: request.id,
          activity_type: ACTIVITY_TYPES.WFH_REJECTED,
          metadata: {
            status: updatedRow?.status ?? 'REJECTED',
            comment: comment ?? null,
            manager_status: updatedRow?.manager_status ?? null,
            hr_status: updatedRow?.hr_status ?? null,
          },
        });
        return res.json(updatedRow);
      }

      const updated = await WfhRequest.query()
        .patch({
          status: 'APPROVED',
          manager_status: 'APPROVED',
          manager_id: req.user.id,
          manager_action_at: new Date().toISOString(),
          approver_comment: comment ?? null,
          updated_by: req.user.id,
        } as any)
        .where('id', requestId)
        .returning('*');
      const updatedRequest = Array.isArray(updated) ? updated[0] : updated;
      await notifyStatus('APPROVED');
      await ActivityLogService.recordActivitySafely({
        org_id: request.org_id,
        actor_user_id: req.user.id,
        target_user_id: request.user_id,
        entity_type: ACTIVITY_ENTITY_TYPES.WFH_REQUEST,
        entity_id: request.id,
        activity_type: ACTIVITY_TYPES.WFH_APPROVED,
        metadata: {
          status: updatedRequest?.status ?? 'APPROVED',
          comment: comment ?? null,
          manager_status: updatedRequest?.manager_status ?? null,
          hr_status: updatedRequest?.hr_status ?? null,
        },
      });
      return res.json({
        message: 'WFH request approved.',
        request: updatedRequest,
      });
    }

    if (action === 'REJECT') {
      const updated = await WfhRequest.query()
        .patch({
          status: 'REJECTED',
          manager_status:
            isAdmin && (request as any).manager_status === 'PENDING'
              ? 'REJECTED'
              : ((request as any).manager_status ?? 'PENDING'),
          hr_status: isHr || isAdmin ? 'REJECTED' : ((request as any).hr_status ?? 'PENDING'),
          manager_id:
            isAdmin && (request as any).manager_status === 'PENDING'
              ? req.user.id
              : ((request as any).manager_id ?? null),
          hr_id: isHr || isAdmin ? req.user.id : ((request as any).hr_id ?? null),
          manager_action_at:
            isAdmin && (request as any).manager_status === 'PENDING'
              ? new Date().toISOString()
              : ((request as any).manager_action_at ?? null),
          hr_action_at:
            isHr || isAdmin ? new Date().toISOString() : ((request as any).hr_action_at ?? null),
          approver_comment: comment ?? null,
          updated_by: req.user.id,
        } as any)
        .where('id', requestId)
        .returning('*');
      const updatedRow = Array.isArray(updated) ? updated[0] : updated;
      await notifyStatus('REJECTED');
      await ActivityLogService.recordActivitySafely({
        org_id: request.org_id,
        actor_user_id: req.user.id,
        target_user_id: request.user_id,
        entity_type: ACTIVITY_ENTITY_TYPES.WFH_REQUEST,
        entity_id: request.id,
        activity_type: ACTIVITY_TYPES.WFH_REJECTED,
        metadata: {
          status: updatedRow?.status ?? 'REJECTED',
          comment: comment ?? null,
          manager_status: updatedRow?.manager_status ?? null,
          hr_status: updatedRow?.hr_status ?? null,
        },
      });
      return res.json(updatedRow);
    }

    const newManagerStatus =
      isAdmin && (request as any).manager_status === 'PENDING'
        ? 'APPROVED'
        : isManager
          ? 'APPROVED'
          : ((request as any).manager_status ?? 'PENDING');
    const newHrStatus = isHr || isAdmin ? 'APPROVED' : ((request as any).hr_status ?? 'PENDING');

    const updated = await WfhRequest.query()
      .patch({
        status: 'APPROVED',
        manager_status: newManagerStatus,
        hr_status: newHrStatus,
        manager_id:
          isAdmin && (request as any).manager_status === 'PENDING'
            ? req.user.id
            : ((request as any).manager_id ?? null),
        hr_id: isHr || isAdmin ? req.user.id : ((request as any).hr_id ?? null),
        manager_action_at:
          isAdmin && (request as any).manager_status === 'PENDING'
            ? new Date().toISOString()
            : ((request as any).manager_action_at ?? null),
        hr_action_at:
          isHr || isAdmin ? new Date().toISOString() : ((request as any).hr_action_at ?? null),
        approver_comment: comment ?? null,
        updated_by: req.user.id,
      } as any)
      .where('id', requestId)
      .returning('*');

    const payload = Array.isArray(updated) ? updated[0] : updated;
    await notifyStatus('APPROVED');
    await ActivityLogService.recordActivitySafely({
      org_id: request.org_id,
      actor_user_id: req.user.id,
      target_user_id: request.user_id,
      entity_type: ACTIVITY_ENTITY_TYPES.WFH_REQUEST,
      entity_id: request.id,
      activity_type: ACTIVITY_TYPES.WFH_APPROVED,
      metadata: {
        status: payload?.status ?? 'APPROVED',
        comment: comment ?? null,
        manager_status: payload?.manager_status ?? null,
        hr_status: payload?.hr_status ?? null,
      },
    });
    return res.json(payload);
  }

  static async updateStatus(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ message: 'request id is required' });
    }

    const parsed = wfhStatusUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { status, comment } = parsed.data;
    if (status === 'CANCELLED') {
      return WfhController.cancelWfhRequest(req, res);
    }

    const role = req.user.role;
    if (!['admin', 'hr', 'manager'].includes(role)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const action = status === 'REJECTED' ? 'REJECT' : 'APPROVE';
    (req as any).body = {
      requestId: id,
      action,
      comment,
    };
    return WfhController.approveRequest(req, res);
  }
}
