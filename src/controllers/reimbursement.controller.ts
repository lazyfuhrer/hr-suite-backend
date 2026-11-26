import type { Request, Response } from 'express';

import { ReimbursementRequest } from '../models/ReimbursementRequest';
import { User } from '../models/User';
import {
  reimbursementApplySchema,
  reimbursementApproveSchema,
  reimbursementMyListQuerySchema,
  reimbursementOrgListQuerySchema,
  reimbursementStatusUpdateSchema,
  updateReimbursementRequestSchema,
  markReimbursementMonthPaidSchema,
  requestCancelBodySchema,
} from '../validators';
import { logger } from '../config/logger';
import {
  canCancelRequestForOwner,
  getManagedDepartmentIds,
  getManagedDepartmentSummaries,
} from '../utils/department-manager.utils';
import {
  ACTIVITY_ENTITY_TYPES,
  ACTIVITY_TYPES,
  ActivityLogService,
} from '../services/activity-log.service';
import {
  notifyReimbursementPaid,
  notifyReimbursementStatusChanged,
  notifyReimbursementSubmitted,
} from '../services/notifications/reimbursement-notification.service';
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

const normalizeAmount = (value: number | string | null | undefined): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

const getExpenseMonthDateRange = (year: number, month: number): { from: string; to: string } => {
  const from = `${year}-${pad2(month)}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const to = `${year}-${pad2(month)}-${pad2(lastDay)}`;
  return { from, to };
};

const approvedPaymentFields = () => ({
  payment_status: 'UNPAID' as const,
  paid_at: null,
  paid_by_user_id: null,
});

const clearedPaymentFields = () => ({
  payment_status: null,
  paid_at: null,
  paid_by_user_id: null,
});

export const formatReimbursementRequestItem = (row: any, options?: { employee?: any }) => ({
  request_type: 'REIMBURSEMENT',
  id: row.id,
  status: row.status,
  created_at: row.created_at ?? null,
  updated_at: row.updated_at ?? null,
  updated_by: row.updated_by ?? null,
  employee: options?.employee ?? null,
  request_date: row.request_date ?? null,
  type: row.type ?? null,
  amount: normalizeAmount(row.amount),
  reason: row.reason ?? null,
  attachment_url: row.attachment_url ?? null,
  approver_comment: row.approver_comment ?? null,
  manager_id: row.manager_id ?? null,
  manager_status: row.manager_status ?? null,
  hr_status: row.hr_status ?? null,
  hr_id: row.hr_id ?? null,
  manager_action_at: row.manager_action_at ?? null,
  hr_action_at: row.hr_action_at ?? null,
  payment_status: row.payment_status ?? null,
  paid_at: row.paid_at ?? null,
  paid_by_user_id: row.paid_by_user_id ?? null,
  details: {
    request_date: row.request_date ?? null,
    type: row.type ?? null,
    amount: normalizeAmount(row.amount),
  },
  record: {
    id: row.id,
    org_id: row.org_id ?? null,
    user_id: row.user_id ?? null,
    manager_id: row.manager_id ?? null,
    request_date: row.request_date ?? null,
    type: row.type ?? null,
    amount: normalizeAmount(row.amount),
    reason: row.reason ?? null,
    status: row.status ?? null,
    approver_comment: row.approver_comment ?? null,
    attachment_url: row.attachment_url ?? null,
    manager_status: row.manager_status ?? null,
    hr_status: row.hr_status ?? null,
    hr_id: row.hr_id ?? null,
    manager_action_at: row.manager_action_at ?? null,
    hr_action_at: row.hr_action_at ?? null,
    payment_status: row.payment_status ?? null,
    paid_at: row.paid_at ?? null,
    paid_by_user_id: row.paid_by_user_id ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    updated_by: row.updated_by ?? null,
  },
});

export class ReimbursementController {
  static async applyReimbursement(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = reimbursementApplySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { request_date, type, reason, amount, attachment_url } = parsed.data;
    const uploadedAttachment = (req as any).reimbursementAttachment as
      | { url?: string; key?: string }
      | undefined;
    const finalAttachmentUrl = uploadedAttachment?.url ?? attachment_url ?? null;
    const org_id = req.user.org_id;
    const user_id = req.user.id;

    const manager_id = (req.user as any).manager_id ?? null;

    const created = await ReimbursementRequest.query().insert({
      org_id,
      user_id,
      manager_id,
      request_date,
      type,
      reason,
      amount,
      status: 'PENDING',
      attachment_url: finalAttachmentUrl,
      updated_by: user_id,
    } as any);

    try {
      await notifyReimbursementSubmitted({
        orgId: org_id,
        reimbursementRequestId: created.id,
        applicantUserId: user_id,
        managerId: manager_id,
        requestDate: request_date,
        amount,
      });
    } catch (err) {
      logger.error(
        { err, org_id, reimbursementRequestId: created.id, employeeUserId: user_id },
        'Failed to send reimbursement-submitted notification',
      );
    }

    await ActivityLogService.recordActivitySafely({
      org_id,
      actor_user_id: user_id,
      target_user_id: user_id,
      entity_type: ACTIVITY_ENTITY_TYPES.REIMBURSEMENT_REQUEST,
      entity_id: created.id,
      activity_type: ACTIVITY_TYPES.REIMBURSEMENT_APPLIED,
      metadata: {
        request_date,
        type,
        amount,
        status: 'PENDING',
      },
    });

    const createdJson =
      created && typeof (created as any).toJSON === 'function'
        ? (created as any).toJSON()
        : created;

    return res.status(201).json({
      ...createdJson,
      amount: normalizeAmount(createdJson.amount),
    });
  }

  static async getReimbursementRequestById(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    const org_id = req.user.org_id;
    const user_id = req.user.id;
    const userRole = (req.user as any).role;

    const request = await ReimbursementRequest.query()
      .withGraphJoined('[user.department, manager]')
      .findById(id);

    if (!request) {
      return res.status(404).json({ message: 'Reimbursement request not found' });
    }

    if (request.org_id !== org_id) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    if (userRole === 'employee' && request.user_id !== user_id) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const item = formatReimbursementRequestItem(request, {
      employee: request.user ? buildEmployeeSummary(request.user) : null,
    });

    return res.json(buildPaginatedResponse(1, 1, 1, [item]));
  }

  static async updateReimbursementRequest(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    const org_id = req.user.org_id;
    const user_id = req.user.id;

    const parsed = updateReimbursementRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const request = await ReimbursementRequest.query().findById(id);
    if (!request) {
      return res.status(404).json({ message: 'Reimbursement request not found' });
    }

    if (request.org_id !== org_id || request.user_id !== user_id) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    if (request.status !== 'PENDING') {
      return res
        .status(400)
        .json({ message: 'Only pending reimbursement requests can be updated' });
    }

    const { request_date, type, reason, amount, attachment_url } = parsed.data;
    const uploadedAttachment = (req as any).reimbursementAttachment as
      | { url?: string; key?: string }
      | undefined;
    const updateData: Record<string, unknown> = {};
    if (request_date !== undefined) updateData.request_date = request_date;
    if (type !== undefined) updateData.type = type;
    if (reason !== undefined) updateData.reason = reason;
    if (amount !== undefined) updateData.amount = amount;

    const finalAttachmentUrl =
      uploadedAttachment?.url ?? (attachment_url !== undefined ? attachment_url : undefined);
    if (finalAttachmentUrl !== undefined) {
      updateData.attachment_url = finalAttachmentUrl;
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ message: 'No fields to update' });
    }

    updateData.updated_by = user_id;

    const updated = await ReimbursementRequest.query().patchAndFetchById(id, updateData);
    const updatedJson =
      updated && typeof (updated as any).toJSON === 'function'
        ? (updated as any).toJSON()
        : updated;

    return res.json({ ...updatedJson, amount: normalizeAmount(updatedJson.amount) });
  }

  static async cancelReimbursementRequest(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    const org_id = req.user.org_id;
    const user_id = req.user.id;
    const role = req.user.role;

    const request = await ReimbursementRequest.query().findById(id);
    if (!request) {
      return res.status(404).json({ message: 'Reimbursement request not found' });
    }

    if (request.org_id !== org_id) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const allowed = await canCancelRequestForOwner({ id: user_id, org_id, role }, request.user_id);
    if (!allowed) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    if (request.status !== 'PENDING' && request.status !== 'APPROVED') {
      return res.status(400).json({
        message: 'Only pending or approved reimbursement requests can be cancelled',
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
      ...clearedPaymentFields(),
    };
    if (comment !== undefined) {
      cancelPatch.approver_comment = comment ?? null;
    }

    const updated = await ReimbursementRequest.query().patchAndFetchById(id, cancelPatch as any);

    await ActivityLogService.recordActivitySafely({
      org_id,
      actor_user_id: user_id,
      target_user_id: request.user_id,
      entity_type: ACTIVITY_ENTITY_TYPES.REIMBURSEMENT_REQUEST,
      entity_id: id,
      activity_type: ACTIVITY_TYPES.REIMBURSEMENT_CANCELLED,
      metadata: {
        status: 'CANCELLED',
        comment: comment ?? null,
        request_date: request.request_date,
        type: request.type,
        amount: normalizeAmount(request.amount),
      },
    });

    const updatedJson =
      updated && typeof (updated as any).toJSON === 'function'
        ? (updated as any).toJSON()
        : updated;

    return res.json({ ...updatedJson, amount: normalizeAmount(updatedJson.amount) });
  }

  static async listMyRequests(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = reimbursementMyListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { page, limit, status, type, start_date, end_date } = parsed.data;
    const org_id = req.user.org_id;
    const user_id = req.user.id;

    const baseQuery = ReimbursementRequest.query()
      .alias('rr')
      .where('rr.org_id', org_id)
      .where('rr.user_id', user_id);

    if (status) baseQuery.where('rr.status', status);
    if (type) baseQuery.where('rr.type', type);
    if (start_date && end_date) {
      baseQuery.whereBetween('rr.request_date', [start_date, end_date]);
    }

    const countQuery = ReimbursementRequest.query()
      .alias('rr')
      .where('rr.org_id', org_id)
      .where('rr.user_id', user_id)
      .modify((qb) => {
        if (status) qb.where('rr.status', status);
        if (type) qb.where('rr.type', type);
        if (start_date && end_date) {
          qb.whereBetween('rr.request_date', [start_date, end_date]);
        }
      });

    const totalRow = await countQuery.count('rr.id as count').first();
    const total = Number((totalRow as { count?: string | number } | undefined)?.count ?? 0);
    const total_pages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(Math.max(page, 1), total_pages);
    const offset = (safePage - 1) * limit;

    const rows = await baseQuery
      .clone()
      .orderBy('rr.created_at', 'desc')
      .limit(limit)
      .offset(offset);

    const items = rows.map((row) =>
      formatReimbursementRequestItem(row, {
        employee: buildEmployeeSummary({ ...req.user, id: user_id }),
      }),
    );

    return res.json(buildPaginatedResponse(safePage, limit, total, items));
  }

  static async listOrgRequests(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = reimbursementOrgListQuerySchema.safeParse(req.query);
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
      type,
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

    const baseQuery = ReimbursementRequest.query()
      .alias('rr')
      .leftJoin('users', 'users.id', 'rr.user_id')
      .leftJoin('departments', 'departments.id', 'users.department_id')
      .where('rr.org_id', org_id)
      .modify((qb) => {
        if (isManager) {
          qb.whereIn('users.department_id', managedDepartmentIds).where('users.role', 'employee');
        }
        if (isManager || isHr) {
          qb.whereNot('rr.user_id', req.user.id);
        }
      });

    if (status) baseQuery.where('rr.status', status);
    if (type) baseQuery.where('rr.type', type);
    if (employee_id) baseQuery.where('rr.user_id', employee_id);
    if (department_id) baseQuery.where('users.department_id', department_id);
    if (rangeFrom && rangeTo) {
      baseQuery.whereBetween('rr.request_date', [rangeFrom, rangeTo]);
    }
    if (search) {
      const term = `%${search}%`;
      baseQuery.where((b) => {
        b.where('users.employee_id', 'ilike', term)
          .orWhere('users.first_name', 'ilike', term)
          .orWhere('users.last_name', 'ilike', term)
          .orWhere('users.official_email', 'ilike', term)
          .orWhere('departments.name', 'ilike', term)
          .orWhere('rr.reason', 'ilike', term);
      });
    }

    const totalRow = await baseQuery.clone().countDistinct('rr.id as count').first();
    const total = Number((totalRow as { count?: string | number } | undefined)?.count ?? 0);
    const total_pages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(Math.max(page, 1), total_pages);
    const offset = (safePage - 1) * limit;

    const rows = await baseQuery
      .clone()
      .select(
        'rr.*',
        'users.employee_id',
        'users.first_name',
        'users.last_name',
        'users.profile_image_url',
        'users.role',
        'users.designation',
        'departments.id as department_id',
        'departments.name as department_name',
      )
      .orderBy('rr.created_at', 'desc')
      .limit(limit)
      .offset(offset);

    const managerUserIds = (rows as any[])
      .filter((row: any) => row.role === 'manager')
      .map((row: any) => String(row.user_id));
    const managerDepartmentsMap = await getManagedDepartmentSummaries(org_id, managerUserIds);

    const data = (rows as any[]).map((row) => {
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

      return formatReimbursementRequestItem(row, {
        employee: buildEmployeeSummary(employeeSource),
      });
    });

    return res.json(buildPaginatedResponse(safePage, limit, total, data));
  }

  /**
   * Reimbursement requests for a specific employee (admin/hr/manager view).
   * GET /api/users/:userId/reimbursements/requests
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

    const parsed = reimbursementOrgListQuerySchema.safeParse(req.query);
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
      type,
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

    const baseQuery = ReimbursementRequest.query()
      .alias('rr')
      .leftJoin('users', 'users.id', 'rr.user_id')
      .leftJoin('departments', 'departments.id', 'users.department_id')
      .where('rr.org_id', org_id)
      .where('rr.user_id', userId);

    if (status) baseQuery.where('rr.status', status);
    if (type) baseQuery.where('rr.type', type);
    if (department_id) baseQuery.where('users.department_id', department_id);
    if (rangeFrom && rangeTo) {
      baseQuery.whereBetween('rr.request_date', [rangeFrom, rangeTo]);
    }
    if (search) {
      const term = `%${search}%`;
      baseQuery.where((b) => {
        b.where('users.employee_id', 'ilike', term)
          .orWhere('users.first_name', 'ilike', term)
          .orWhere('users.last_name', 'ilike', term)
          .orWhere('users.official_email', 'ilike', term)
          .orWhere('departments.name', 'ilike', term)
          .orWhere('rr.reason', 'ilike', term);
      });
    }

    const totalRow = await baseQuery.clone().countDistinct('rr.id as count').first();
    const total = Number((totalRow as { count?: string | number } | undefined)?.count ?? 0);
    const total_pages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(Math.max(page, 1), total_pages);
    const offset = (safePage - 1) * limit;

    const rows = await baseQuery
      .clone()
      .select(
        'rr.*',
        'users.employee_id',
        'users.first_name',
        'users.last_name',
        'users.profile_image_url',
        'users.role',
        'users.designation',
        'departments.id as department_id',
        'departments.name as department_name',
      )
      .orderBy('rr.created_at', 'desc')
      .limit(limit)
      .offset(offset);

    const managerDepartmentsForTarget =
      (targetUser as any).role === 'manager'
        ? ((await getManagedDepartmentSummaries(org_id, [userId])).get(userId) ?? [])
        : [];

    const data = (rows as any[]).map((row) => {
      let manager_departments: Array<{ id: string; name: string }> | undefined;
      if (row.role === 'manager') {
        const fromMap = managerDepartmentsForTarget;
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

      return formatReimbursementRequestItem(row, {
        employee: buildEmployeeSummary(employeeSource),
      });
    });

    return res.json(buildPaginatedResponse(safePage, limit, total, data));
  }

  static async listOrgRequestsForCurrentUserFromPath(
    req: Request,
    res: Response,
  ): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    (req as any).params = { ...req.params, userId: req.user.id };
    return ReimbursementController.listOrgRequestsForUser(req, res);
  }

  static async approveRequest(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = reimbursementApproveSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { requestId, action, comment } = parsed.data;
    const request = await ReimbursementRequest.query().findById(requestId);
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
        await notifyReimbursementStatusChanged({
          orgId: request.org_id,
          reimbursementRequestId: request.id,
          employeeUserId: request.user_id,
          requestDate: request.request_date,
          amount: normalizeAmount(request.amount),
          status,
        });
      } catch (err) {
        logger.error(
          { err, org_id: request.org_id, reimbursementRequestId: request.id },
          'Failed to send reimbursement status notification',
        );
      }
    };

    const recordActivity = async (
      activityType: (typeof ACTIVITY_TYPES)[keyof typeof ACTIVITY_TYPES],
      updatedRow: any,
    ) => {
      await ActivityLogService.recordActivitySafely({
        org_id: request.org_id,
        actor_user_id: req.user!.id,
        target_user_id: request.user_id,
        entity_type: ACTIVITY_ENTITY_TYPES.REIMBURSEMENT_REQUEST,
        entity_id: request.id,
        activity_type: activityType,
        metadata: {
          status: updatedRow?.status ?? null,
          comment: comment ?? null,
          manager_status: updatedRow?.manager_status ?? null,
          hr_status: updatedRow?.hr_status ?? null,
        },
      });
    };

    if (isManager && !isAdmin) {
      if ((request as any).manager_status !== 'PENDING') {
        return res.status(400).json({ message: 'Manager already processed this request' });
      }

      if (action === 'REJECT') {
        const updated = await ReimbursementRequest.query()
          .patch({
            status: 'REJECTED',
            manager_status: 'REJECTED',
            manager_id: req.user.id,
            manager_action_at: new Date().toISOString(),
            approver_comment: comment ?? null,
            updated_by: req.user.id,
            ...clearedPaymentFields(),
          } as any)
          .where('id', requestId)
          .returning('*');

        const updatedRow = Array.isArray(updated) ? updated[0] : updated;
        await notifyStatus('REJECTED');
        await recordActivity(ACTIVITY_TYPES.REIMBURSEMENT_REJECTED, updatedRow);
        return res.json(updatedRow);
      }

      const updated = await ReimbursementRequest.query()
        .patch({
          status: 'APPROVED',
          manager_status: 'APPROVED',
          manager_id: req.user.id,
          manager_action_at: new Date().toISOString(),
          approver_comment: comment ?? null,
          updated_by: req.user.id,
          ...approvedPaymentFields(),
        } as any)
        .where('id', requestId)
        .returning('*');

      const updatedRequest = Array.isArray(updated) ? updated[0] : updated;
      await notifyStatus('APPROVED');
      await recordActivity(ACTIVITY_TYPES.REIMBURSEMENT_APPROVED, updatedRequest);
      return res.json({
        message: 'Reimbursement request approved.',
        request: updatedRequest,
      });
    }

    if (action === 'REJECT') {
      const updated = await ReimbursementRequest.query()
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
          ...clearedPaymentFields(),
        } as any)
        .where('id', requestId)
        .returning('*');

      const updatedRow = Array.isArray(updated) ? updated[0] : updated;
      await notifyStatus('REJECTED');
      await recordActivity(ACTIVITY_TYPES.REIMBURSEMENT_REJECTED, updatedRow);
      return res.json(updatedRow);
    }

    const newManagerStatus =
      isAdmin && (request as any).manager_status === 'PENDING'
        ? 'APPROVED'
        : isManager
          ? 'APPROVED'
          : ((request as any).manager_status ?? 'PENDING');
    const newHrStatus = isHr || isAdmin ? 'APPROVED' : ((request as any).hr_status ?? 'PENDING');

    const updated = await ReimbursementRequest.query()
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
        ...approvedPaymentFields(),
      } as any)
      .where('id', requestId)
      .returning('*');

    const payload = Array.isArray(updated) ? updated[0] : updated;
    await notifyStatus('APPROVED');
    await recordActivity(ACTIVITY_TYPES.REIMBURSEMENT_APPROVED, payload);
    return res.json(payload);
  }

  /**
   * Mark all approved reimbursement requests for an employee's expense month as paid.
   * POST /api/users/:userId/reimbursements/mark-month-paid
   * Admin, HR, and managers (same access as per-employee reimbursement list).
   */
  static async markMonthPaidForUser(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const role = (req.user as any).role;
    if (!['admin', 'hr', 'manager'].includes(role)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const parsed = markReimbursementMonthPaidSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { userId } = req.params;
    const { year, month } = parsed.data;
    const org_id = req.user.org_id;

    const targetUser = await User.query().findById(userId).where('org_id', org_id);
    if (!targetUser) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const { from, to } = getExpenseMonthDateRange(year, month);
    const paidAt = new Date().toISOString();

    const approvedInMonth = await ReimbursementRequest.query()
      .where('org_id', org_id)
      .where('user_id', userId)
      .where('status', 'APPROVED')
      .whereBetween('request_date', [from, to]);

    const approvedTotal = approvedInMonth.length;
    const unpaidRows = approvedInMonth.filter((row) => row.payment_status !== 'PAID');

    if (unpaidRows.length === 0) {
      const paidTotal = approvedInMonth.reduce((sum, row) => sum + normalizeAmount(row.amount), 0);
      return res.json({
        year,
        month,
        user_id: userId,
        updated_count: 0,
        approved_total: approvedTotal,
        paid_total: paidTotal,
      });
    }

    const updated = await ReimbursementRequest.query()
      .patch({
        payment_status: 'PAID',
        paid_at: paidAt,
        paid_by_user_id: req.user.id,
        updated_by: req.user.id,
      } as any)
      .where('org_id', org_id)
      .where('user_id', userId)
      .where('status', 'APPROVED')
      .whereBetween('request_date', [from, to])
      .where((qb) => {
        qb.where('payment_status', '!=', 'PAID').orWhereNull('payment_status');
      })
      .returning('*');

    const updatedRows = Array.isArray(updated) ? updated : updated ? [updated] : [];
    const paidTotal = approvedInMonth.reduce((sum, row) => sum + normalizeAmount(row.amount), 0);

    for (const row of updatedRows) {
      try {
        await notifyReimbursementPaid({
          orgId: org_id,
          reimbursementRequestId: String((row as any).id),
          employeeUserId: String((row as any).user_id),
          requestDate: String((row as any).request_date),
          amount: normalizeAmount((row as any).amount),
          paidAt,
        });
      } catch (err) {
        logger.error(
          { err, org_id, reimbursementRequestId: (row as any).id, employeeUserId: userId },
          'Failed to send reimbursement-paid notification',
        );
      }
    }

    await ActivityLogService.recordActivitySafely({
      org_id,
      actor_user_id: req.user.id,
      target_user_id: userId,
      entity_type: ACTIVITY_ENTITY_TYPES.REIMBURSEMENT_REQUEST,
      entity_id: userId,
      activity_type: ACTIVITY_TYPES.REIMBURSEMENT_MONTH_PAID,
      metadata: {
        year,
        month,
        updated_count: updatedRows.length,
        approved_total: approvedTotal,
        expense_month_from: from,
        expense_month_to: to,
      },
    });

    return res.json({
      year,
      month,
      user_id: userId,
      updated_count: updatedRows.length,
      approved_total: approvedTotal,
      paid_total: paidTotal,
    });
  }

  static async updateStatus(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ message: 'request id is required' });
    }

    const parsed = reimbursementStatusUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { status, comment } = parsed.data;
    if (status === 'CANCELLED') {
      return ReimbursementController.cancelReimbursementRequest(req, res);
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

    return ReimbursementController.approveRequest(req, res);
  }
}
