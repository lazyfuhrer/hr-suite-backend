import type { Request, Response } from 'express';

import { LeaveRequest } from '../models/LeaveRequest';
import { LeaveType } from '../models/LeaveType';
import { User } from '../models/User';
import {
  leaveApplySchema,
  leaveApproveSchema,
  leaveDashboardQuerySchema,
  managerLeaveDashboardQuerySchema,
  leaveMyListQuerySchema,
  leaveMySummaryQuerySchema,
  leaveOrgListQuerySchema,
  leaveStatusUpdateSchema,
  createLeaveTypeSchema,
  updateLeaveTypeSchema,
  updateLeaveRequestSchema,
  requestCancelBodySchema,
} from '../validators';

import { addCalendarDays, formatDateLocal, normalizeDate } from '../utils/date.utils';
import { isUserAttendanceScheduledDay } from '../utils/attendance-schedule.utils';
import {
  canCancelRequestForOwner,
  fetchPrimaryManagedDepartmentScheduleByManagerIds,
  getManagedDepartmentIds,
  getManagedDepartmentSummaries,
} from '../utils/department-manager.utils';
import {
  applyDaySessionFactor,
  buildLeaveDaysContextForRows,
  calculateEffectiveQuota,
  countLeaveDaysForRow,
  countLeaveDaysInRange,
  daySessionsCollide,
  resolveLeaveScheduleForRow,
} from '../utils/leave.utils';
import {
  assertHalfDayShiftConfigured,
  enrichLeaveRowsWithSessionWindows,
  resolveShiftForUser,
  sessionWindowForLeaveRow,
  type LeaveSessionWindow,
} from '../utils/leave-session.utils';
import {
  buildOverlapDepartmentIdsFromRow,
  calculateApprovedDepartmentTeammateOverlapCount,
  resolveOverlapDepartmentIds,
} from '../utils/leave-teammate-overlap.utils';
import { fetchEffectiveHolidayDateSet } from '../utils/attendance-schedule.utils';
import { HelpdeskTicket } from '../models/HelpdeskTicket';
import { logger } from '../config/logger';
import { REAL_EMPLOYEE_STATUSES } from '../constants/user-status';
import {
  ACTIVITY_ENTITY_TYPES,
  ACTIVITY_TYPES,
  ActivityLogService,
} from '../services/activity-log.service';
import {
  notifyLeaveCancelled,
  notifyLeaveStatusChanged,
  notifyLeaveSubmitted,
} from '../services/notifications/leave-notification.service';
import { buildEmployeeSummary } from '../utils/employee-summary.utils';

const getYearRange = (year: number): { start: string; end: string } => {
  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year, 11, 31));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
};

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

const formatLeaveRequestItem = (
  row: any,
  options?: {
    employee?: any;
    leave_type?: any;
    teammate_overlap_count?: number;
    total_days?: number | null;
    session_window?: LeaveSessionWindow | null;
  },
) => ({
  id: row.id,
  request_type: 'LEAVE',
  status: row.status,
  created_at: row.created_at ?? null,
  updated_at: row.updated_at ?? null,
  updated_by: row.updated_by ?? null,
  employee: options?.employee ?? null,
  leave_type: options?.leave_type ?? null,
  start_date: row.start_date ?? null,
  end_date: row.end_date ?? null,
  day_session: row.day_session ?? 'FULL',
  session_window: options?.session_window ?? null,
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
  teammate_overlap_count: options?.teammate_overlap_count ?? 0,
  details: {
    start_date: row.start_date ?? null,
    end_date: row.end_date ?? null,
    leave_type_name: options?.leave_type?.name ?? row.leave_type_name ?? null,
    teammate_overlap_count: options?.teammate_overlap_count ?? 0,
  },
  record: {
    id: row.id,
    org_id: row.org_id ?? null,
    user_id: row.user_id ?? null,
    manager_id: row.manager_id ?? null,
    leave_type_id: row.leave_type_id ?? null,
    start_date: row.start_date ?? null,
    end_date: row.end_date ?? null,
    day_session: row.day_session ?? 'FULL',
    session_window: options?.session_window ?? null,
    reason: row.reason ?? null,
    status: row.status ?? null,
    approver_comment: row.approver_comment ?? null,
    total_days: options?.total_days !== undefined ? options.total_days : (row.total_days ?? null),
    attachment_url: row.attachment_url ?? null,
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

export class LeaveController {
  static async listLeaveTypes(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const rows = await LeaveType.query().where('org_id', req.user.org_id).orderBy('name', 'asc');

    return res.json({ items: rows });
  }

  static async createLeaveType(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = createLeaveTypeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { name, annual_quota } = parsed.data;
    const org_id = req.user.org_id;

    const existing = await LeaveType.query().findOne({ org_id, name });
    if (existing) {
      return res.status(409).json({ message: 'Leave type already exists' });
    }

    const created = await LeaveType.query().insert({
      org_id,
      name,
      annual_quota,
    });

    return res.status(201).json(created);
  }

  static async updateLeaveType(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    const parsed = updateLeaveTypeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const leaveType = await LeaveType.query().findById(id);
    if (!leaveType) {
      return res.status(404).json({ message: 'Leave type not found' });
    }

    if (leaveType.org_id !== req.user.org_id) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const { name, annual_quota } = parsed.data;

    // Check for duplicate name if name is being updated
    if (name && name !== leaveType.name) {
      const existing = await LeaveType.query().findOne({
        org_id: req.user.org_id,
        name,
      });
      if (existing) {
        return res.status(409).json({ message: 'Leave type name already exists' });
      }
    }

    const updateData: Partial<LeaveType> = {};
    if (name !== undefined) updateData.name = name;
    if (annual_quota !== undefined) updateData.annual_quota = annual_quota;

    const updated = await LeaveType.query().patchAndFetchById(id, updateData);

    return res.json(updated);
  }

  static async deleteLeaveType(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;

    const leaveType = await LeaveType.query().findById(id);
    if (!leaveType) {
      return res.status(404).json({ message: 'Leave type not found' });
    }

    if (leaveType.org_id !== req.user.org_id) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    // Check if there are any leave requests using this type
    const hasRequests = await LeaveRequest.query().where('leave_type_id', id).first();

    if (hasRequests) {
      return res.status(409).json({
        message: 'Cannot delete leave type with existing leave requests',
      });
    }

    await LeaveType.query().deleteById(id);

    return res.status(204).send();
  }

  static async applyLeave(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = leaveApplySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { leave_type_id, start_date, end_date, day_session, reason, attachment_url } =
      parsed.data;
    const uploadedAttachment = (req as any).leaveAttachment as
      | { url?: string; key?: string }
      | undefined;
    const finalAttachmentUrl = uploadedAttachment?.url ?? attachment_url ?? null;
    const org_id = req.user.org_id;
    const user_id = req.user.id;

    const leaveType = await LeaveType.query().findById(leave_type_id);
    if (!leaveType || leaveType.org_id !== org_id) {
      return res.status(400).json({ message: 'Invalid leave_type_id' });
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

    const totalDays = await countLeaveDaysInRange({
      org_id,
      startDate: start_date,
      endDate: end_date,
      departmentId: applicantSchedule.departmentId,
      workingDays: applicantSchedule.workingDays,
      userId: user_id,
    });

    if (totalDays <= 0) {
      return res.status(400).json({ message: 'Invalid date range' });
    }

    const requestedDays = applyDaySessionFactor(totalDays, day_session);

    let sessionWindow: LeaveSessionWindow | null = null;
    if (day_session !== 'FULL') {
      const shift = await resolveShiftForUser(org_id, user_id);
      const shiftCheck = assertHalfDayShiftConfigured(shift, day_session);
      if (!shiftCheck.ok) {
        return res.status(400).json({ message: shiftCheck.message });
      }
      sessionWindow = shiftCheck.window;
    }

    const dateOverlapping = await LeaveRequest.query()
      .where('org_id', org_id)
      .where('user_id', user_id)
      .whereIn('status', ['PENDING', 'APPROVED'])
      .where((qb) => {
        qb.whereBetween('start_date', [start_date, end_date])
          .orWhereBetween('end_date', [start_date, end_date])
          .orWhere((inner) =>
            inner.where('start_date', '<=', start_date).where('end_date', '>=', end_date),
          );
      });

    const overlapping = dateOverlapping.filter((r) =>
      daySessionsCollide(day_session, r.day_session),
    );

    if (overlapping.length > 0) {
      return res.status(409).json({
        message: 'Leave dates overlap with an existing request',
        conflict_request_ids: overlapping.map((r) => r.id),
      });
    }

    const startYear = new Date(start_date).getFullYear();
    const { start: yearStart, end: yearEnd } = getYearRange(startYear);

    const yearRequests = await LeaveRequest.query()
      .where('org_id', org_id)
      .where('user_id', user_id)
      .where('leave_type_id', leave_type_id)
      .whereBetween('start_date', [yearStart, yearEnd])
      .whereIn('status', ['PENDING', 'APPROVED']);

    const yearHolidaySet = await fetchEffectiveHolidayDateSet(org_id, user_id, yearStart, yearEnd);
    const applicantScheduleRow = {
      role: applicantRow?.role,
      department_id: applicantRow?.department_id,
      department_working_days: (applicantRow as any)?.department_working_days,
      user_id,
    };

    let approvedDays = 0;
    let pendingDays = 0;
    for (const reqRow of yearRequests) {
      const days = countLeaveDaysForRow({
        row: {
          ...applicantScheduleRow,
          start_date: reqRow.start_date,
          end_date: reqRow.end_date,
          day_session: reqRow.day_session,
        },
        holidaySet: yearHolidaySet,
        managedScheduleByManagerId,
      });
      if (reqRow.status === 'APPROVED') {
        approvedDays += days;
      } else if (reqRow.status === 'PENDING') {
        pendingDays += days;
      }
    }

    const doj = req.user.date_of_joining ?? '2000-01-01'; // Default to old date if missing
    const effectiveQuota = calculateEffectiveQuota(leaveType.annual_quota, doj, startYear);
    const remainingQuota = effectiveQuota - approvedDays;

    if (requestedDays > remainingQuota) {
      return res.status(400).json({
        message: 'Leave quota exceeded for this type',
        details: {
          annual_quota: effectiveQuota, // Show effective quota
          approved_days: approvedDays,
          pending_days: pendingDays,
          requested_days: requestedDays,
        },
      });
    }

    const manager_id = (req.user as any).manager_id ?? null;

    const created = await LeaveRequest.query().insert({
      org_id,
      user_id,
      manager_id,
      leave_type_id,
      start_date,
      end_date,
      day_session,
      reason,
      status: 'PENDING',
      total_days: requestedDays,
      attachment_url: finalAttachmentUrl,
      updated_by: user_id,
    } as any);

    // Best-effort notifications: leave creation must not fail due to push/FCM issues.
    try {
      await notifyLeaveSubmitted({
        orgId: org_id,
        leaveRequestId: created.id,
        applicantUserId: user_id,
        managerId: manager_id,
        leaveTypeId: leave_type_id,
        startDate: start_date,
        endDate: end_date,
      });
    } catch (err) {
      logger.error(
        { err, org_id, leaveRequestId: created.id, employeeUserId: user_id },
        'Failed to send leave-submitted notification',
      );
    }

    await ActivityLogService.recordActivitySafely({
      org_id,
      actor_user_id: user_id,
      target_user_id: user_id,
      entity_type: ACTIVITY_ENTITY_TYPES.LEAVE_REQUEST,
      entity_id: created.id,
      activity_type: ACTIVITY_TYPES.LEAVE_APPLIED,
      metadata: {
        leave_type_id,
        start_date,
        end_date,
        day_session,
        total_days: requestedDays,
        status: 'PENDING',
      },
    });

    const sessionSuffix =
      day_session === 'FIRST_HALF'
        ? ' (first half)'
        : day_session === 'SECOND_HALF'
          ? ' (second half)'
          : '';

    // Create a linked helpdesk ticket for this leave request (best-effort).
    try {
      const subject =
        `Leave request: ${leaveType.name} ${start_date} to ${end_date}${sessionSuffix}`.slice(
          0,
          255,
        );
      await HelpdeskTicket.query()
        .insert({
          org_id,
          created_by: user_id,
          category: 'leave',
          subject,
          description: reason ?? `Leave request for ${requestedDays} day(s).`,
          priority: 'MEDIUM',
          status: 'OPEN',
          resolution: 'PENDING',
          leave_request_id: created.id,
          attachment_file_url: finalAttachmentUrl,
        } as any)
        .onConflict(['org_id', 'leave_request_id'])
        .ignore();
    } catch {
      // Backwards-compatible retry if DB constraint doesn't allow PENDING yet.
      try {
        const subject =
          `Leave request: ${leaveType.name} ${start_date} to ${end_date}${sessionSuffix}`.slice(
            0,
            255,
          );
        await HelpdeskTicket.query()
          .insert({
            org_id,
            created_by: user_id,
            category: 'leave',
            subject,
            description: reason ?? `Leave request for ${requestedDays} day(s).`,
            priority: 'MEDIUM',
            status: 'OPEN',
            leave_request_id: created.id,
            attachment_file_url: finalAttachmentUrl,
          } as any)
          .onConflict(['org_id', 'leave_request_id'])
          .ignore();
      } catch (err) {
        // Do not block leave creation if helpdesk ticket creation fails.
        logger.error(
          { err, org_id, user_id, leave_request_id: created.id },
          'Failed to create linked helpdesk ticket for leave request',
        );
      }
    }

    const createdJson =
      created && typeof (created as any).toJSON === 'function'
        ? (created as any).toJSON()
        : created;

    return res
      .status(201)
      .json({ ...createdJson, total_days: requestedDays, session_window: sessionWindow });
  }

  static async getLeaveRequestById(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    const org_id = req.user.org_id;
    const user_id = req.user.id;
    const userRole = (req.user as any).role;

    const request = await LeaveRequest.query()
      .withGraphJoined('[leaveType, user.department, manager]')
      .findById(id);

    if (!request) {
      return res.status(404).json({ message: 'Leave request not found' });
    }

    // Check org access
    if (request.org_id !== org_id) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    // Employees can only view their own requests; admin/hr/manager can view any
    if (userRole === 'employee' && request.user_id !== user_id) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const response: any = {
      leave_type: request.leaveType
        ? {
            id: request.leaveType.id,
            name: request.leaveType.name,
            annual_quota: request.leaveType.annual_quota,
            effective_quota:
              request.user && request.leaveType
                ? calculateEffectiveQuota(
                    request.leaveType.annual_quota,
                    (request.user as any).date_of_joining ?? '2000-01-01',
                    new Date(request.start_date).getFullYear(),
                  )
                : null,
          }
        : null,
      employee: request.user ? buildEmployeeSummary(request.user) : null,
      manager: request.manager
        ? {
            id: request.manager.id,
            full_name: `${(request.manager as any).first_name} ${(request.manager as any).last_name}`,
            profile_image_url: (request.manager as any).profile_image_url ?? null,
          }
        : null,
    };

    // Calculate remaining_days and used_days for this leave type & employee for the relevant year
    if (response.leave_type && response.leave_type.effective_quota != null) {
      try {
        const startDateObj = request.start_date ? new Date(request.start_date) : new Date();
        const year = startDateObj.getUTCFullYear();
        const { start: yearStart, end: yearEnd } = getYearRange(year);

        const approvedRequests = await LeaveRequest.query()
          .where('org_id', org_id)
          .where('user_id', request.user_id)
          .where('leave_type_id', request.leave_type_id)
          .whereBetween('start_date', [yearStart, yearEnd])
          .where('status', 'APPROVED');

        const requestUser = request.user as any;
        const managedScheduleByManagerId =
          requestUser?.role === 'manager'
            ? await fetchPrimaryManagedDepartmentScheduleByManagerIds(org_id, [
                String(request.user_id),
              ])
            : new Map();
        const scheduleRow = {
          role: requestUser?.role,
          department_id: requestUser?.department_id ?? requestUser?.department?.id,
          department_working_days: requestUser?.department?.working_days,
          user_id: request.user_id,
        };
        const yearHolidaySet = await fetchEffectiveHolidayDateSet(
          org_id,
          String(request.user_id),
          yearStart,
          yearEnd,
        );

        let approvedDaysForType = 0;
        for (const r of approvedRequests) {
          approvedDaysForType += countLeaveDaysForRow({
            row: {
              ...scheduleRow,
              start_date: r.start_date,
              end_date: r.end_date,
              day_session: r.day_session,
            },
            holidaySet: yearHolidaySet,
            managedScheduleByManagerId,
          });
        }

        const effectiveQuota = Number(response.leave_type.effective_quota ?? 0);
        const remaining_days = Math.max(0, effectiveQuota - approvedDaysForType);

        response.leave_type.used_days = approvedDaysForType;
        response.leave_type.remaining_days = remaining_days;
      } catch {
        // If anything fails, leave the extra fields undefined; core payload still works.
      }
    }

    const requestUserForOverlap = request.user as any;
    const overlapDepartmentIds = await resolveOverlapDepartmentIds(
      org_id,
      String(request.user_id),
      requestUserForOverlap?.role,
      requestUserForOverlap?.department_id ?? requestUserForOverlap?.department?.id ?? null,
    );
    const teammateOverlapCount = await calculateApprovedDepartmentTeammateOverlapCount({
      org_id,
      request_id: request.id,
      user_id: request.user_id,
      department_ids: overlapDepartmentIds,
      start_date: request.start_date,
      end_date: request.end_date,
    });

    const requestUserForDays = request.user as any;
    const managedForDays =
      requestUserForDays?.role === 'manager'
        ? await fetchPrimaryManagedDepartmentScheduleByManagerIds(org_id, [String(request.user_id)])
        : new Map();
    const computedTotalDays = countLeaveDaysForRow({
      row: {
        role: requestUserForDays?.role,
        department_id: requestUserForDays?.department_id ?? requestUserForDays?.department?.id,
        department_working_days: requestUserForDays?.department?.working_days,
        user_id: request.user_id,
        start_date: request.start_date,
        end_date: request.end_date,
        day_session: request.day_session,
      },
      holidaySet: await fetchEffectiveHolidayDateSet(
        org_id,
        String(request.user_id),
        normalizeDate(request.start_date) ?? '',
        normalizeDate(request.end_date) ?? '',
      ),
      managedScheduleByManagerId: managedForDays,
    });

    const item = formatLeaveRequestItem(request, {
      teammate_overlap_count: teammateOverlapCount,
      employee: response.employee,
      total_days: computedTotalDays,
      session_window: sessionWindowForLeaveRow(
        await resolveShiftForUser(org_id, request.user_id),
        request.day_session,
      ),
      leave_type: {
        ...(response.leave_type ?? {}),
      },
    });

    return res.json(buildPaginatedResponse(1, 1, 1, [{ ...item, manager: response.manager }]));
  }

  static async updateLeaveRequest(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    const org_id = req.user.org_id;
    const user_id = req.user.id;

    const parsed = updateLeaveRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const request = await LeaveRequest.query().findById(id);
    if (!request) {
      return res.status(404).json({ message: 'Leave request not found' });
    }

    if (request.org_id !== org_id) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    // Only the request owner can update
    if (request.user_id !== user_id) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    // Only PENDING requests can be updated
    if (request.status !== 'PENDING') {
      return res.status(400).json({
        message: 'Only pending leave requests can be updated',
      });
    }

    const { leave_type_id, start_date, end_date, day_session, reason, attachment_url } =
      parsed.data;

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

    const applicantScheduleRow = {
      role: applicantRow?.role,
      department_id: applicantRow?.department_id,
      department_working_days: (applicantRow as any)?.department_working_days,
      user_id,
    };

    const applicantSchedule = resolveLeaveScheduleForRow(
      applicantScheduleRow,
      managedScheduleByManagerId,
    );

    // If dates are being updated, validate them
    const finalStartDate = start_date ?? request.start_date;
    const finalEndDate = end_date ?? request.end_date;
    const finalDaySession = day_session ?? request.day_session ?? 'FULL';

    if (
      finalDaySession !== 'FULL' &&
      normalizeDate(finalStartDate) !== normalizeDate(finalEndDate)
    ) {
      return res.status(400).json({
        message: 'A half-day leave must start and end on the same date',
      });
    }

    const totalDays = await countLeaveDaysInRange({
      org_id,
      startDate: finalStartDate,
      endDate: finalEndDate,
      departmentId: applicantSchedule.departmentId,
      workingDays: applicantSchedule.workingDays,
      userId: user_id,
    });
    if (totalDays <= 0) {
      return res.status(400).json({ message: 'Invalid date range' });
    }

    const requestedDays = applyDaySessionFactor(totalDays, finalDaySession);

    let sessionWindow: LeaveSessionWindow | null = null;
    if (finalDaySession !== 'FULL') {
      const shift = await resolveShiftForUser(org_id, user_id);
      const shiftCheck = assertHalfDayShiftConfigured(shift, finalDaySession);
      if (!shiftCheck.ok) {
        return res.status(400).json({ message: shiftCheck.message });
      }
      sessionWindow = shiftCheck.window;
    }

    // If leave_type_id is being updated, validate it
    const finalLeaveTypeId = leave_type_id ?? request.leave_type_id;
    const leaveType = await LeaveType.query().findById(finalLeaveTypeId);
    if (!leaveType || leaveType.org_id !== org_id) {
      return res.status(400).json({ message: 'Invalid leave_type_id' });
    }

    // Check for overlaps (excluding the current request)
    if (start_date || end_date || day_session) {
      const dateOverlapping = await LeaveRequest.query()
        .where('org_id', org_id)
        .where('user_id', user_id)
        .where('id', '!=', id)
        .whereIn('status', ['PENDING', 'APPROVED'])
        .where((qb) => {
          qb.whereBetween('start_date', [finalStartDate, finalEndDate])
            .orWhereBetween('end_date', [finalStartDate, finalEndDate])
            .orWhere((inner) =>
              inner.where('start_date', '<=', finalStartDate).where('end_date', '>=', finalEndDate),
            );
        });

      const overlapping = dateOverlapping.filter((r) =>
        daySessionsCollide(finalDaySession, r.day_session),
      );

      if (overlapping.length > 0) {
        return res.status(409).json({
          message: 'Leave dates overlap with an existing request',
          conflict_request_ids: overlapping.map((r) => r.id),
        });
      }
    }

    // Check quota if dates, session or leave type changed
    if (start_date || end_date || day_session || leave_type_id) {
      const year = new Date(finalStartDate).getFullYear();
      const { start, end } = getYearRange(year);

      const existingApproved = await LeaveRequest.query()
        .where('org_id', org_id)
        .where('user_id', user_id)
        .where('leave_type_id', finalLeaveTypeId)
        .where('id', '!=', id)
        .whereIn('status', ['APPROVED', 'PENDING'])
        .whereBetween('start_date', [start, end]);

      const yearHolidaySet = await fetchEffectiveHolidayDateSet(org_id, user_id, start, end);
      const existingDays = existingApproved.reduce(
        (sum, r) =>
          sum +
          countLeaveDaysForRow({
            row: {
              ...applicantScheduleRow,
              start_date: r.start_date,
              end_date: r.end_date,
              day_session: r.day_session,
            },
            holidaySet: yearHolidaySet,
            managedScheduleByManagerId,
          }),
        0,
      );
      const approvedDays = existingDays + requestedDays;

      const doj =
        (request as any).user?.date_of_joining ?? req.user.date_of_joining ?? '2000-01-01'; // Try to get from request.user (joined) or req.user (current)
      // Note: request.user might not be joined if not eager loaded, but we need it.
      // Actually `updateLeaveRequest` does NOT eager load `user`. But `req.user` is the owner so we use that.

      const effectiveQuota = calculateEffectiveQuota(leaveType.annual_quota, doj, year);

      if (approvedDays > effectiveQuota) {
        return res.status(400).json({
          message: 'Leave request exceeds annual quota',
          annual_quota: effectiveQuota,
          requested_days: requestedDays,
          already_used_days: approvedDays - requestedDays,
          remaining_days: effectiveQuota - (approvedDays - requestedDays),
        });
      }
    }

    // Build update data
    const updateData: any = {};
    if (leave_type_id !== undefined) updateData.leave_type_id = leave_type_id;
    if (start_date !== undefined) updateData.start_date = start_date;
    if (end_date !== undefined) updateData.end_date = end_date;
    if (day_session !== undefined) updateData.day_session = day_session;
    if (reason !== undefined) updateData.reason = reason;
    if (attachment_url !== undefined) updateData.attachment_url = attachment_url;
    updateData.total_days = requestedDays;
    updateData.updated_by = user_id;

    const updated = await LeaveRequest.query().patchAndFetchById(id, updateData);
    const updatedJson =
      updated && typeof (updated as any).toJSON === 'function'
        ? (updated as any).toJSON()
        : updated;

    return res.json({ ...updatedJson, total_days: requestedDays, session_window: sessionWindow });
  }

  static async cancelLeaveRequest(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    const org_id = req.user.org_id;
    const user_id = req.user.id;
    const role = req.user.role;

    const request = await LeaveRequest.query().findById(id);
    if (!request) {
      return res.status(404).json({ message: 'Leave request not found' });
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
        message: 'Only pending or approved leave requests can be cancelled',
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

    const updated = await LeaveRequest.transaction(async (trx) => {
      try {
        await HelpdeskTicket.query(trx)
          .where('org_id', org_id)
          .where('leave_request_id', id)
          .patch({ status: 'RESOLVED', updated_at: now });
      } catch {
        // ignore helpdesk sync failures
      }
      return LeaveRequest.query(trx).patchAndFetchById(id, cancelPatch as any);
    });

    await ActivityLogService.recordActivitySafely({
      org_id,
      actor_user_id: user_id,
      target_user_id: request.user_id,
      entity_type: ACTIVITY_ENTITY_TYPES.LEAVE_REQUEST,
      entity_id: id,
      activity_type: ACTIVITY_TYPES.LEAVE_CANCELLED,
      metadata: {
        status: 'CANCELLED',
        comment: comment ?? null,
        start_date: request.start_date,
        end_date: request.end_date,
        leave_type_id: request.leave_type_id,
      },
    });

    if (!isOwner) {
      try {
        await notifyLeaveCancelled({
          orgId: org_id,
          leaveRequestId: id,
          employeeUserId: request.user_id,
          leaveTypeId: request.leave_type_id,
          startDate: String(request.start_date).slice(0, 10),
          endDate: String(request.end_date).slice(0, 10),
        });
      } catch (err) {
        logger.warn({ err, leaveRequestId: id }, 'Failed to send leave cancelled notification');
      }
    }

    const updatedJson =
      updated && typeof (updated as any).toJSON === 'function'
        ? (updated as any).toJSON()
        : updated;

    return res.json(updatedJson);
  }

  static async listMyRequests(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = leaveMyListQuerySchema.safeParse(req.query);
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
    const currentDepartmentId = currentUser?.department_id ?? null;

    const baseQuery = LeaveRequest.query()
      .alias('lr')
      .withGraphJoined('leaveType')
      .where('lr.org_id', org_id)
      .where('lr.user_id', user_id);

    if (status) {
      baseQuery.where('lr.status', status);
    }
    if (start_date && end_date) {
      baseQuery.whereBetween('lr.start_date', [start_date, end_date]);
    }

    // Separate lightweight count query to avoid issues with graph joins & selected columns.
    const countQuery = LeaveRequest.query()
      .alias('lr')
      .where('lr.org_id', org_id)
      .where('lr.user_id', user_id);

    if (status) {
      countQuery.where('lr.status', status);
    }
    if (start_date && end_date) {
      countQuery.whereBetween('lr.start_date', [start_date, end_date]);
    }

    const totalRow = await countQuery.countDistinct('lr.id as count').first();
    const total = Number((totalRow as { count?: string | number } | undefined)?.count ?? 0);
    const total_pages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(Math.max(page, 1), total_pages);
    const offset = (safePage - 1) * limit;

    const rows = await baseQuery
      .clone()
      .select('lr.*')
      .orderBy('lr.created_at', 'desc')
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

    const myOverlapDepartmentIds = await resolveOverlapDepartmentIds(
      org_id,
      user_id,
      currentUser?.role,
      currentDepartmentId,
    );

    const applicantShift = await resolveShiftForUser(org_id, user_id);

    const data = await Promise.all(
      rows.map(async (row: any) => {
        const approvedDepartmentTeammateOverlapCount =
          await calculateApprovedDepartmentTeammateOverlapCount({
            org_id,
            request_id: row.id,
            user_id: user_id,
            department_ids: myOverlapDepartmentIds,
            start_date: row.start_date,
            end_date: row.end_date,
          });

        const leaveTypeName = row.leaveType ? row.leaveType.name : null;
        const computedTotalDays = countLeaveDaysForRow({
          row: {
            ...myScheduleRow,
            start_date: row.start_date,
            end_date: row.end_date,
            day_session: row.day_session,
          },
          holidaySet: myHolidaySet,
          holidaySetByUserId: myHolidaySetByUserId,
          managedScheduleByManagerId: myManagedSchedule,
        });

        return {
          request_type: 'LEAVE',
          id: row.id,
          total_days: computedTotalDays,
          day_session: row.day_session ?? 'FULL',
          session_window: sessionWindowForLeaveRow(applicantShift, row.day_session),
          employee: buildEmployeeSummary(currentUser),
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
            leave_type_name: leaveTypeName,
            teammate_overlap_count: approvedDepartmentTeammateOverlapCount,
          },
          record: {
            id: row.id,
            user_id: row.user_id,
            leave_type_id: row.leave_type_id ?? null,
            start_date: row.start_date,
            end_date: row.end_date,
            total_days: computedTotalDays,
            day_session: row.day_session ?? 'FULL',
            session_window: sessionWindowForLeaveRow(applicantShift, row.day_session),
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
        };
      }),
    );

    return res.json(buildPaginatedResponse(safePage, limit, total, data));
  }

  static async getMySummary(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = leaveMySummaryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const org_id = req.user.org_id;
    const user_id = req.user.id;

    const now = new Date();
    const year = parsed.data.year ?? now.getFullYear();
    const { start, end } = getYearRange(year);

    const [types, requests, summaryUserRow] = await Promise.all([
      LeaveType.query().where('org_id', org_id).orderBy('name', 'asc'),
      LeaveRequest.query()
        .where('org_id', org_id)
        .where('user_id', user_id)
        .whereBetween('start_date', [start, end]),
      User.query()
        .alias('u')
        .leftJoin('departments as d', 'd.id', 'u.department_id')
        .where('u.id', user_id)
        .select('u.role', 'u.department_id', 'd.working_days as department_working_days')
        .first(),
    ]);

    const summaryManagedSchedule =
      summaryUserRow?.role === 'manager'
        ? await fetchPrimaryManagedDepartmentScheduleByManagerIds(org_id, [user_id])
        : new Map();
    const summaryScheduleRow = {
      role: summaryUserRow?.role,
      department_id: summaryUserRow?.department_id,
      department_working_days: (summaryUserRow as any)?.department_working_days,
      user_id,
    };
    const summaryHolidaySet = await fetchEffectiveHolidayDateSet(org_id, user_id, start, end);

    const byType = new Map<
      string,
      { approved_days: number; pending_days: number; rejected_days: number }
    >();

    for (const reqRow of requests) {
      const days = countLeaveDaysForRow({
        row: {
          ...summaryScheduleRow,
          start_date: reqRow.start_date,
          end_date: reqRow.end_date,
          day_session: reqRow.day_session,
        },
        holidaySet: summaryHolidaySet,
        managedScheduleByManagerId: summaryManagedSchedule,
      });
      const key = reqRow.leave_type_id;
      if (!byType.has(key)) {
        byType.set(key, { approved_days: 0, pending_days: 0, rejected_days: 0 });
      }
      const agg = byType.get(key)!;
      if (reqRow.status === 'APPROVED') agg.approved_days += days;
      else if (reqRow.status === 'PENDING') agg.pending_days += days;
      else if (reqRow.status === 'REJECTED') agg.rejected_days += days;
    }

    const items = types.map((t) => {
      const agg = byType.get(t.id) ?? {
        approved_days: 0,
        pending_days: 0,
        rejected_days: 0,
      };

      const doj = req.user?.date_of_joining ?? '2000-01-01';
      const effectiveQuota = calculateEffectiveQuota(t.annual_quota, doj, year);

      const remaining_days = Math.max(0, effectiveQuota - agg.approved_days);
      return {
        id: t.id,
        name: t.name,
        annual_quota: t.annual_quota,
        effective_quota: effectiveQuota, // Add explicit effective quota
        approved_days: agg.approved_days,
        pending_days: agg.pending_days,
        rejected_days: agg.rejected_days,
        remaining_days,
      };
    });

    return res.json({
      year,
      items,
    });
  }

  static async listOrgRequests(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = leaveOrgListQuerySchema.safeParse(req.query);
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
      leave_type_id,
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
      managedDepartmentIds = await getManagedDepartmentIds(org_id, req.user.id);
    }

    const baseQuery = LeaveRequest.query()
      .alias('lr')
      .leftJoin('users', 'users.id', 'lr.user_id')
      .leftJoin('departments', 'departments.id', 'users.department_id')
      .leftJoin('leave_types', 'leave_types.id', 'lr.leave_type_id')
      .where('lr.org_id', org_id)
      .modify((qb) => {
        if (isManager) {
          qb.whereIn('users.department_id', managedDepartmentIds).where('users.role', 'employee');
        }
        // Managers & HR should not see their own requests in org lists
        if (isManager || isHr) {
          qb.whereNot('lr.user_id', req.user.id);
        }
      });

    if (status) baseQuery.where('lr.status', status);
    if (leave_type_id) baseQuery.where('lr.leave_type_id', leave_type_id);
    if (employee_id) baseQuery.where('lr.user_id', employee_id);
    if (department_id) baseQuery.where('users.department_id', department_id);
    if (rangeFrom && rangeTo) {
      baseQuery.where((qb) => {
        qb.whereBetween('lr.start_date', [rangeFrom, rangeTo])
          .orWhereBetween('lr.end_date', [rangeFrom, rangeTo])
          .orWhere((inner) =>
            inner.where('lr.start_date', '<=', rangeFrom).where('lr.end_date', '>=', rangeTo),
          );
      });
    }
    if (search) {
      const term = `%${search}%`;
      baseQuery.where((b) => {
        b.where('users.employee_id', 'ilike', term)
          .orWhere('users.first_name', 'ilike', term)
          .orWhere('users.last_name', 'ilike', term)
          .orWhere('users.official_email', 'ilike', term)
          .orWhere('departments.name', 'ilike', term)
          .orWhere('leave_types.name', 'ilike', term);
      });
    }

    const totalRow = await baseQuery.clone().countDistinct('lr.id as count').first();
    const total = Number((totalRow as { count?: string | number } | undefined)?.count ?? 0);
    const total_pages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(Math.max(page, 1), total_pages);
    const offset = (safePage - 1) * limit;

    const rows = await baseQuery
      .clone()
      .select(
        'lr.*',
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
        'leave_types.name as leave_type_name',
        'leave_types.annual_quota as leave_type_annual_quota',
      )
      .orderBy('lr.created_at', 'desc')
      .limit(limit)
      .offset(offset);

    // Build department arrays for manager employees (consistent with /api/users)
    const managerUserIds = (rows as any[])
      .filter((row: any) => row.role === 'manager')
      .map((row: any) => String(row.user_id));

    const managerDepartmentsMap = await getManagedDepartmentSummaries(org_id, managerUserIds);
    const {
      holidaySet: orgListHolidaySet,
      holidaySetByUserId: orgListHolidaySetByUserId,
      managedScheduleByManagerId: orgListManagedSchedule,
    } = await buildLeaveDaysContextForRows(org_id, rows as any[]);

    const sessionWindowsByRow = await enrichLeaveRowsWithSessionWindows(org_id, rows as any[]);

    const data: any[] = [];

    for (const row of rows as any[]) {
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

      const computedTotalDays = countLeaveDaysForRow({
        row,
        holidaySet: orgListHolidaySet,
        holidaySetByUserId: orgListHolidaySetByUserId,
        managedScheduleByManagerId: orgListManagedSchedule,
      });

      data.push({
        request_type: 'LEAVE',
        id: row.id,
        total_days: computedTotalDays,
        day_session: row.day_session ?? 'FULL',
        session_window: sessionWindowsByRow.get(row) ?? null,
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
          total_days: computedTotalDays,
          day_session: row.day_session ?? 'FULL',
          session_window: sessionWindowsByRow.get(row) ?? null,
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

    return res.json(buildPaginatedResponse(safePage, limit, total, data));
  }

  /**
   * Org-level leave requests for a specific employee (admin/hr/manager view).
   * GET /api/users/:userId/leaves/requests
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

    const parsed = leaveOrgListQuerySchema.safeParse(req.query);
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
      leave_type_id,
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

    const baseQuery = LeaveRequest.query()
      .alias('lr')
      .leftJoin('users', 'users.id', 'lr.user_id')
      .leftJoin('departments', 'departments.id', 'users.department_id')
      .leftJoin('leave_types', 'leave_types.id', 'lr.leave_type_id')
      .where('lr.org_id', org_id)
      .where('lr.user_id', userId);

    if (status) baseQuery.where('lr.status', status);
    if (leave_type_id) baseQuery.where('lr.leave_type_id', leave_type_id);
    if (department_id) baseQuery.where('users.department_id', department_id);
    if (rangeFrom && rangeTo) {
      baseQuery.where((qb) => {
        qb.whereBetween('lr.start_date', [rangeFrom, rangeTo])
          .orWhereBetween('lr.end_date', [rangeFrom, rangeTo])
          .orWhere((inner) =>
            inner.where('lr.start_date', '<=', rangeFrom).where('lr.end_date', '>=', rangeTo),
          );
      });
    }
    if (search) {
      const term = `%${search}%`;
      baseQuery.where((b) => {
        b.where('users.employee_id', 'ilike', term)
          .orWhere('users.first_name', 'ilike', term)
          .orWhere('users.last_name', 'ilike', term)
          .orWhere('users.official_email', 'ilike', term)
          .orWhere('departments.name', 'ilike', term)
          .orWhere('leave_types.name', 'ilike', term);
      });
    }

    const totalRow = await baseQuery.clone().countDistinct('lr.id as count').first();
    const total = Number((totalRow as { count?: string | number } | undefined)?.count ?? 0);
    const total_pages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(Math.max(page, 1), total_pages);
    const offset = (safePage - 1) * limit;

    const rows = await baseQuery
      .clone()
      .select(
        'lr.*',
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
        'leave_types.name as leave_type_name',
        'leave_types.annual_quota as leave_type_annual_quota',
      )
      .orderBy('lr.created_at', 'desc')
      .limit(limit)
      .offset(offset);

    const managerDepartmentsForMe =
      req.user.role === 'manager'
        ? ((await getManagedDepartmentSummaries(org_id, [userId])).get(userId) ?? [])
        : [];

    const targetOverlapDepartmentIds = await resolveOverlapDepartmentIds(
      org_id,
      userId,
      (targetUser as any).role,
      (targetUser as any).department_id ?? null,
    );

    const {
      holidaySet: userListHolidaySet,
      holidaySetByUserId: userListHolidaySetByUserId,
      managedScheduleByManagerId: userListManagedSchedule,
    } = await buildLeaveDaysContextForRows(org_id, rows as any[]);

    const userListSessionWindows = await enrichLeaveRowsWithSessionWindows(org_id, rows as any[]);

    const data: any[] = [];

    for (const row of rows as any[]) {
      const approvedDepartmentTeammateOverlapCount =
        await calculateApprovedDepartmentTeammateOverlapCount({
          org_id,
          request_id: row.id,
          user_id: row.user_id,
          department_ids: targetOverlapDepartmentIds,
          start_date: row.start_date,
          end_date: row.end_date,
        });

      const computedTotalDays = countLeaveDaysForRow({
        row,
        holidaySet: userListHolidaySet,
        holidaySetByUserId: userListHolidaySetByUserId,
        managedScheduleByManagerId: userListManagedSchedule,
      });

      // Compute remaining leaves for this employee & leave type (for the relevant year)
      let remaining_days: number | null = null;
      try {
        const startDateObj = row.start_date ? new Date(row.start_date) : new Date();
        const year = startDateObj.getUTCFullYear();
        const { start: yearStart, end: yearEnd } = getYearRange(year);

        const approvedRequests = await LeaveRequest.query()
          .where('org_id', org_id)
          .where('user_id', row.user_id)
          .where('leave_type_id', row.leave_type_id)
          .whereBetween('start_date', [yearStart, yearEnd])
          .where('status', 'APPROVED');

        const yearHolidaySet = await fetchEffectiveHolidayDateSet(
          org_id,
          String(row.user_id),
          yearStart,
          yearEnd,
        );
        let approvedDaysForType = 0;
        for (const r of approvedRequests) {
          approvedDaysForType += countLeaveDaysForRow({
            row: {
              ...row,
              start_date: r.start_date,
              end_date: r.end_date,
              day_session: r.day_session,
            },
            holidaySet: yearHolidaySet,
            managedScheduleByManagerId: userListManagedSchedule,
          });
        }

        const annualQuota = Number(row.leave_type_annual_quota ?? 0);
        const doj = row.date_of_joining ?? '2000-01-01';
        const effectiveQuota = calculateEffectiveQuota(annualQuota, doj, year);
        remaining_days = Math.max(0, effectiveQuota - approvedDaysForType);
      } catch {
        remaining_days = null;
      }

      data.push(
        formatLeaveRequestItem(row, {
          teammate_overlap_count: approvedDepartmentTeammateOverlapCount,
          total_days: computedTotalDays,
          session_window: userListSessionWindows.get(row) ?? null,
          employee: buildEmployeeSummary(
            row.role === 'manager'
              ? { ...row, id: row.user_id, manager_departments: managerDepartmentsForMe }
              : { ...row, id: row.user_id },
          ),
          leave_type: {
            id: row.leave_type_id,
            name: row.leave_type_name,
            remaining_days,
          },
        }),
      );
    }

    return res.json(buildPaginatedResponse(safePage, limit, total, data));
  }

  /**
   * Org-style leave list for current JWT user.
   * GET /api/users/:userId/leaves/requests/my
   *
   * Note: path param userId is intentionally ignored; JWT user id is used.
   * Query params and response shape match listOrgRequestsForUser.
   */
  static async listOrgRequestsForCurrentUserFromPath(
    req: Request,
    res: Response,
  ): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const userId = req.user.id;
    const parsed = leaveOrgListQuerySchema.safeParse(req.query);
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
      leave_type_id,
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

    const baseQuery = LeaveRequest.query()
      .alias('lr')
      .leftJoin('users', 'users.id', 'lr.user_id')
      .leftJoin('departments', 'departments.id', 'users.department_id')
      .leftJoin('leave_types', 'leave_types.id', 'lr.leave_type_id')
      .where('lr.org_id', org_id)
      .where('lr.user_id', userId);

    if (status) baseQuery.where('lr.status', status);
    if (leave_type_id) baseQuery.where('lr.leave_type_id', leave_type_id);
    if (department_id) baseQuery.where('users.department_id', department_id);
    if (rangeFrom && rangeTo) {
      baseQuery.where((qb) => {
        qb.whereBetween('lr.start_date', [rangeFrom, rangeTo])
          .orWhereBetween('lr.end_date', [rangeFrom, rangeTo])
          .orWhere((inner) =>
            inner.where('lr.start_date', '<=', rangeFrom).where('lr.end_date', '>=', rangeTo),
          );
      });
    }
    if (search) {
      const term = `%${search}%`;
      baseQuery.where((b) => {
        b.where('users.employee_id', 'ilike', term)
          .orWhere('users.first_name', 'ilike', term)
          .orWhere('users.last_name', 'ilike', term)
          .orWhere('users.official_email', 'ilike', term)
          .orWhere('departments.name', 'ilike', term)
          .orWhere('leave_types.name', 'ilike', term);
      });
    }

    const totalRow = await baseQuery.clone().countDistinct('lr.id as count').first();
    const total = Number((totalRow as { count?: string | number } | undefined)?.count ?? 0);
    const total_pages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(Math.max(page, 1), total_pages);
    const offset = (safePage - 1) * limit;

    const rows = await baseQuery
      .clone()
      .select(
        'lr.*',
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
        'leave_types.name as leave_type_name',
        'leave_types.annual_quota as leave_type_annual_quota',
      )
      .orderBy('lr.created_at', 'desc')
      .limit(limit)
      .offset(offset);

    const managerDepartmentsForMe =
      req.user.role === 'manager'
        ? ((await getManagedDepartmentSummaries(org_id, [userId])).get(userId) ?? [])
        : [];

    const pathApplicant = await User.query()
      .findById(userId)
      .where('org_id', org_id)
      .select('role', 'department_id');
    const myPathOverlapDepartmentIds = await resolveOverlapDepartmentIds(
      org_id,
      userId,
      (pathApplicant as any)?.role ?? req.user.role,
      (pathApplicant as any)?.department_id ?? null,
    );

    const {
      holidaySet: myPathHolidaySet,
      holidaySetByUserId: myPathHolidaySetByUserId,
      managedScheduleByManagerId: myPathManagedSchedule,
    } = await buildLeaveDaysContextForRows(org_id, rows as any[]);

    const pathApplicantShift = await resolveShiftForUser(org_id, userId);

    const data: any[] = [];

    for (const row of rows as any[]) {
      const approvedDepartmentTeammateOverlapCount =
        await calculateApprovedDepartmentTeammateOverlapCount({
          org_id,
          request_id: row.id,
          user_id: row.user_id,
          department_ids: myPathOverlapDepartmentIds,
          start_date: row.start_date,
          end_date: row.end_date,
        });

      const computedTotalDays = countLeaveDaysForRow({
        row,
        holidaySet: myPathHolidaySet,
        holidaySetByUserId: myPathHolidaySetByUserId,
        managedScheduleByManagerId: myPathManagedSchedule,
      });

      data.push({
        request_type: 'LEAVE',
        id: row.id,
        total_days: computedTotalDays,
        day_session: row.day_session ?? 'FULL',
        session_window: sessionWindowForLeaveRow(pathApplicantShift, row.day_session),
        employee: buildEmployeeSummary(
          row.role === 'manager'
            ? { ...row, id: row.user_id, manager_departments: managerDepartmentsForMe }
            : { ...row, id: row.user_id },
        ),
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
          total_days: computedTotalDays,
          day_session: row.day_session ?? 'FULL',
          session_window: sessionWindowForLeaveRow(pathApplicantShift, row.day_session),
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

    return res.json(buildPaginatedResponse(safePage, limit, total, data));
  }

  static async approveRequest(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = leaveApproveSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { requestId, action, comment } = parsed.data;

    const request = await LeaveRequest.query().findById(requestId);
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

    // Managers and HRs must not approve/reject their own leave requests
    if ((isManager || isHr) && String(request.user_id) === String(req.user.id)) {
      return res.status(403).json({ message: 'You cannot approve or reject your own request' });
    }

    // Manager (non-admin): approve/reject sets overall status immediately; applicant is notified.
    if (isManager && !isAdmin) {
      if ((request as any).manager_status !== 'PENDING') {
        return res.status(400).json({ message: 'Manager already processed this request' });
      }

      if (action === 'REJECT') {
        const updated = await LeaveRequest.query()
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
        // Best-effort notifications: leave status update must not fail due to push/FCM issues.
        try {
          await notifyLeaveStatusChanged({
            orgId: request.org_id,
            leaveRequestId: request.id,
            employeeUserId: request.user_id,
            leaveTypeId: request.leave_type_id,
            startDate: request.start_date,
            endDate: request.end_date,
            status: 'REJECTED',
          });
        } catch (err) {
          logger.error(
            {
              err,
              org_id: request.org_id,
              leaveRequestId: request.id,
              employeeUserId: request.user_id,
            },
            'Failed to send leave-rejected notification (manager step)',
          );
        }
        await ActivityLogService.recordActivitySafely({
          org_id: request.org_id,
          actor_user_id: req.user.id,
          target_user_id: request.user_id,
          entity_type: ACTIVITY_ENTITY_TYPES.LEAVE_REQUEST,
          entity_id: request.id,
          activity_type: ACTIVITY_TYPES.LEAVE_REJECTED,
          metadata: {
            status: updatedRow?.status ?? 'REJECTED',
            comment: comment ?? null,
            manager_status: updatedRow?.manager_status ?? null,
            hr_status: updatedRow?.hr_status ?? null,
          },
        });

        return res.json(updatedRow);
      }

      const updated = await LeaveRequest.query()
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
      try {
        await notifyLeaveStatusChanged({
          orgId: request.org_id,
          leaveRequestId: request.id,
          employeeUserId: request.user_id,
          leaveTypeId: request.leave_type_id,
          startDate: request.start_date,
          endDate: request.end_date,
          status: 'APPROVED',
        });
      } catch (err) {
        logger.error(
          {
            err,
            org_id: request.org_id,
            leaveRequestId: request.id,
            employeeUserId: request.user_id,
          },
          'Failed to send leave-approved notification (manager approve)',
        );
      }
      try {
        await HelpdeskTicket.query()
          .where('org_id', request.org_id)
          .where('leave_request_id', request.id)
          .patch({ status: 'RESOLVED', updated_at: new Date() });
      } catch {
        // ignore
      }

      await ActivityLogService.recordActivitySafely({
        org_id: request.org_id,
        actor_user_id: req.user.id,
        target_user_id: request.user_id,
        entity_type: ACTIVITY_ENTITY_TYPES.LEAVE_REQUEST,
        entity_id: request.id,
        activity_type: ACTIVITY_TYPES.LEAVE_APPROVED,
        metadata: {
          status: updatedRequest?.status ?? 'APPROVED',
          comment: comment ?? null,
          manager_status: updatedRequest?.manager_status ?? null,
          hr_status: updatedRequest?.hr_status ?? null,
        },
      });

      return res.json({
        message: 'Leave request approved.',
        request: updatedRequest,
      });
    }

    if (action === 'REJECT') {
      // Admin can reject directly, setting both statuses
      const updated = await LeaveRequest.query()
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
      try {
        await notifyLeaveStatusChanged({
          orgId: request.org_id,
          leaveRequestId: request.id,
          employeeUserId: request.user_id,
          leaveTypeId: request.leave_type_id,
          startDate: request.start_date,
          endDate: request.end_date,
          status: 'REJECTED',
        });
      } catch (err) {
        logger.error(
          {
            err,
            org_id: request.org_id,
            leaveRequestId: request.id,
            employeeUserId: request.user_id,
          },
          'Failed to send leave-rejected notification (admin reject)',
        );
      }

      await ActivityLogService.recordActivitySafely({
        org_id: request.org_id,
        actor_user_id: req.user.id,
        target_user_id: request.user_id,
        entity_type: ACTIVITY_ENTITY_TYPES.LEAVE_REQUEST,
        entity_id: request.id,
        activity_type: ACTIVITY_TYPES.LEAVE_REJECTED,
        metadata: {
          status: updatedRow?.status ?? 'REJECTED',
          comment: comment ?? null,
          manager_status: updatedRow?.manager_status ?? null,
          hr_status: updatedRow?.hr_status ?? null,
        },
      });

      // Sync linked helpdesk ticket (best-effort)
      try {
        await HelpdeskTicket.query()
          .where('org_id', request.org_id)
          .where('leave_request_id', request.id)
          .patch({ status: 'RESOLVED', updated_at: new Date() });
      } catch {
        // ignore
      }

      return res.json(updatedRow);
    }

    // Admin/HR approval (and admin-as-manager): overall APPROVED; applicant notified here when HR/admin acts.
    const newManagerStatus =
      isAdmin && (request as any).manager_status === 'PENDING'
        ? 'APPROVED'
        : isManager
          ? 'APPROVED'
          : ((request as any).manager_status ?? 'PENDING');
    const newHrStatus = isHr || isAdmin ? 'APPROVED' : ((request as any).hr_status ?? 'PENDING');
    const finalStatus = 'APPROVED';

    const updated = await LeaveRequest.query()
      .patch({
        status: finalStatus,
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
    try {
      await notifyLeaveStatusChanged({
        orgId: request.org_id,
        leaveRequestId: request.id,
        employeeUserId: request.user_id,
        leaveTypeId: request.leave_type_id,
        startDate: request.start_date,
        endDate: request.end_date,
        status: 'APPROVED',
      });
    } catch (err) {
      logger.error(
        {
          err,
          org_id: request.org_id,
          leaveRequestId: request.id,
          employeeUserId: request.user_id,
        },
        'Failed to send leave-approved notification (final approval)',
      );
    }
    await ActivityLogService.recordActivitySafely({
      org_id: request.org_id,
      actor_user_id: req.user.id,
      target_user_id: request.user_id,
      entity_type: ACTIVITY_ENTITY_TYPES.LEAVE_REQUEST,
      entity_id: request.id,
      activity_type: ACTIVITY_TYPES.LEAVE_APPROVED,
      metadata: {
        status: payload?.status ?? 'APPROVED',
        comment: comment ?? null,
        manager_status: payload?.manager_status ?? null,
        hr_status: payload?.hr_status ?? null,
      },
    });
    // Sync linked helpdesk ticket (best-effort)
    try {
      await HelpdeskTicket.query()
        .where('org_id', request.org_id)
        .where('leave_request_id', request.id)
        .patch({ status: 'RESOLVED', updated_at: new Date() });
    } catch {
      // ignore
    }
    return res.json(payload);
  }

  // REST-ier status update endpoint: PATCH /leaves/requests/:id/status
  static async updateStatus(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ message: 'request id is required' });
    }

    const parsed = leaveStatusUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { status, comment } = parsed.data;
    if (status === 'CANCELLED') {
      return LeaveController.cancelLeaveRequest(req, res);
    }

    const role = req.user.role;
    if (!['admin', 'hr', 'manager'].includes(role)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    // Map desired status to legacy action values expected by approveRequest()
    const action = status === 'REJECTED' ? 'REJECT' : 'APPROVE';

    (req as any).body = {
      requestId: id,
      action,
      comment,
    };

    return LeaveController.approveRequest(req, res);
  }

  static async getManagerEmployeesDashboard(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const role = req.user.role;
    const isManager = role === 'manager';
    const isHr = role === 'hr';
    if (!isManager && !isHr) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const parsed = managerLeaveDashboardQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { from_date, to_date, page, limit, search } = parsed.data;
    const org_id = req.user.org_id;

    // Managers are restricted to their managed departments; HR sees the whole org.
    let managedDepartmentIds: string[] = [];
    if (isManager) {
      managedDepartmentIds = await getManagedDepartmentIds(org_id, req.user.id);
    }

    const [totalEmployeesRow, leaveTypes, totalOnLeaveRow, leaveTypeRows] = await Promise.all([
      // Total active people in scope:
      // - For managers: active employees in their managed departments
      // - For HR: active employees + managers + HR across the org
      User.query()
        .alias('u')
        .where('u.org_id', org_id)
        .whereIn('u.status', REAL_EMPLOYEE_STATUSES as readonly string[])
        .whereNull('u.deleted_at')
        .modify((qb) => {
          if (isManager) {
            if (managedDepartmentIds.length === 0) {
              qb.whereRaw('1 = 0');
              return;
            }
            qb.whereIn('u.department_id', managedDepartmentIds).where('u.role', 'employee');
          } else if (isHr) {
            qb.whereIn('u.role', ['employee', 'manager', 'hr']);
          }
        })
        .countDistinct('u.id as count')
        .first(),
      LeaveType.query().where('org_id', org_id).orderBy('name', 'asc'),
      // Total people on approved leave in the period (same scoping as above)
      // Count DISTINCT leave requests in scope for the period
      // (align with employees_on_leave.total, which is based on lr.id)
      LeaveRequest.query()
        .alias('lr')
        .innerJoin('users as u', 'u.id', 'lr.user_id')
        .where('lr.org_id', org_id)
        .where('lr.status', 'APPROVED')
        .whereIn('u.status', REAL_EMPLOYEE_STATUSES as readonly string[])
        .whereNull('u.deleted_at')
        .modify((qb) => {
          if (isManager) {
            if (managedDepartmentIds.length === 0) {
              qb.whereRaw('1 = 0');
              return;
            }
            qb.whereIn('u.department_id', managedDepartmentIds).where('u.role', 'employee');
          } else if (isHr) {
            qb.whereIn('u.role', ['employee', 'manager', 'hr']);
          }
        })
        .where((qb) => {
          qb.whereBetween('lr.start_date', [from_date, to_date])
            .orWhereBetween('lr.end_date', [from_date, to_date])
            .orWhere((inner) =>
              inner.where('lr.start_date', '<=', from_date).where('lr.end_date', '>=', to_date),
            );
        })
        .countDistinct('lr.id as count')
        .first(),
      // Per-leave-type counts over the same population (distinct requests per type)
      LeaveRequest.query()
        .alias('lr')
        .innerJoin('users as u', 'u.id', 'lr.user_id')
        .where('lr.org_id', org_id)
        .where('lr.status', 'APPROVED')
        .whereIn('u.status', REAL_EMPLOYEE_STATUSES as readonly string[])
        .whereNull('u.deleted_at')
        .modify((qb) => {
          if (isManager) {
            if (managedDepartmentIds.length === 0) {
              qb.whereRaw('1 = 0');
              return;
            }
            qb.whereIn('u.department_id', managedDepartmentIds).where('u.role', 'employee');
          } else if (isHr) {
            qb.whereIn('u.role', ['employee', 'manager', 'hr']);
          }
        })
        .where((qb) => {
          qb.whereBetween('lr.start_date', [from_date, to_date])
            .orWhereBetween('lr.end_date', [from_date, to_date])
            .orWhere((inner) =>
              inner.where('lr.start_date', '<=', from_date).where('lr.end_date', '>=', to_date),
            );
        })
        .select('lr.leave_type_id')
        .countDistinct('lr.id as employee_count')
        .groupBy('lr.leave_type_id'),
    ]);

    const totalEmployees = Number(
      (totalEmployeesRow as { count?: string | number } | undefined)?.count ?? 0,
    );
    const totalOnLeave = Number(
      (totalOnLeaveRow as { count?: string | number } | undefined)?.count ?? 0,
    );
    const percentageOnLeave =
      totalEmployees > 0 ? Math.round((totalOnLeave / totalEmployees) * 100 * 100) / 100 : 0;

    const leaveTypeCountMap = new Map<string, number>();
    for (const row of leaveTypeRows as Array<{
      leave_type_id?: string;
      employee_count?: number | string;
    }>) {
      if (!row.leave_type_id) {
        continue;
      }
      leaveTypeCountMap.set(row.leave_type_id, Number(row.employee_count ?? 0));
    }

    const cardsSummary = {
      total_on_leave: {
        employee_count: totalOnLeave,
        total_employees: totalEmployees,
        percentage_of_total_employees: percentageOnLeave,
      },
      leave_types: leaveTypes.map((type) => {
        const employeeCount = leaveTypeCountMap.get(type.id) ?? 0;
        return {
          leave_type_id: type.id,
          leave_type_name: type.name,
          employee_count: employeeCount,
          percentage_of_total_on_leave:
            totalOnLeave > 0 ? Math.round((employeeCount / totalOnLeave) * 100 * 100) / 100 : 0,
        };
      }),
    };

    const employeeListBaseQuery = LeaveRequest.query()
      .alias('lr')
      .innerJoin('users as u', 'u.id', 'lr.user_id')
      .leftJoin('departments as d', 'd.id', 'u.department_id')
      .leftJoin('leave_types as lt', 'lt.id', 'lr.leave_type_id')
      .where('lr.org_id', org_id)
      .where('lr.status', 'APPROVED')
      .whereIn('u.status', REAL_EMPLOYEE_STATUSES as readonly string[])
      .whereNull('u.deleted_at')
      .modify((qb) => {
        if (isManager) {
          if (managedDepartmentIds.length === 0) {
            qb.whereRaw('1 = 0');
            return;
          }
          qb.whereIn('u.department_id', managedDepartmentIds).where('u.role', 'employee');
        } else if (isHr) {
          qb.whereIn('u.role', ['employee', 'manager', 'hr']);
        }
      })
      .where((qb) => {
        qb.whereBetween('lr.start_date', [from_date, to_date])
          .orWhereBetween('lr.end_date', [from_date, to_date])
          .orWhere((inner) =>
            inner.where('lr.start_date', '<=', from_date).where('lr.end_date', '>=', to_date),
          );
      });

    if (search) {
      const term = `%${search}%`;
      employeeListBaseQuery.where((qb) => {
        qb.where('u.first_name', 'ilike', term)
          .orWhere('u.last_name', 'ilike', term)
          .orWhereRaw(`concat_ws(' ', u.first_name, u.last_name) ilike ?`, [term])
          .orWhere('u.employee_id', 'ilike', term);
      });
    }

    const totalRow = await employeeListBaseQuery.clone().countDistinct('lr.id as count').first();
    const total = Number((totalRow as { count?: string | number } | undefined)?.count ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(Math.max(page, 1), totalPages);
    const offset = (safePage - 1) * limit;

    const rows = await employeeListBaseQuery
      .clone()
      .select(
        'lr.id',
        'lr.user_id',
        'lr.leave_type_id',
        'lr.start_date',
        'lr.end_date',
        'lr.total_days',
        'lr.day_session',
        'lr.status',
        'u.employee_id',
        'u.first_name',
        'u.last_name',
        'u.profile_image_url',
        'u.designation',
        'u.role',
        'd.id as department_id',
        'd.name as department_name',
        'd.working_days as department_working_days',
        'lt.name as leave_type_name',
      )
      .orderBy('lr.start_date', 'asc')
      .orderBy('lr.created_at', 'desc')
      .limit(limit)
      .offset(offset);

    const {
      holidaySet: mgrDashHolidaySet,
      holidaySetByUserId: mgrDashHolidaySetByUserId,
      managedScheduleByManagerId: mgrDashManagedSchedule,
    } = await buildLeaveDaysContextForRows(org_id, rows as any[]);

    const mgrDashSessionWindows = await enrichLeaveRowsWithSessionWindows(org_id, rows as any[]);

    const items = (rows as any[]).map((row) => ({
      leave_request_id: row.id,
      start_date: row.start_date,
      end_date: row.end_date,
      total_days: countLeaveDaysForRow({
        row: { ...row, user_id: row.user_id },
        holidaySet: mgrDashHolidaySet,
        holidaySetByUserId: mgrDashHolidaySetByUserId,
        managedScheduleByManagerId: mgrDashManagedSchedule,
      }),
      day_session: row.day_session ?? 'FULL',
      session_window: mgrDashSessionWindows.get(row) ?? null,
      status: row.status,
      leave_type: {
        id: row.leave_type_id,
        name: row.leave_type_name ?? null,
      },
      employee: {
        id: row.user_id,
        employee_id: row.employee_id ?? null,
        full_name: `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim(),
        designation: row.designation ?? null,
        department: row.department_id ? { id: row.department_id, name: row.department_name } : null,
        profile_image_url: row.profile_image_url ?? null,
      },
    }));

    return res.json({
      from_date,
      to_date,
      cards_summary: cardsSummary,
      employees_on_leave: buildPaginatedResponse(safePage, limit, total, items),
    });
  }

  static async getDashboard(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Validate query params.
    const parsed = leaveDashboardQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }
    const { from_date, to_date, focus_date } = parsed.data;
    const org_id = req.user.org_id;
    const isManager = req.user.role === 'manager';

    let managedDepartmentIds: string[] = [];
    let managedEmployeeIds: string[] = [];
    if (isManager) {
      managedDepartmentIds = await getManagedDepartmentIds(org_id, req.user.id);

      const managedEmployees = await User.query()
        .where('org_id', org_id)
        .where('role', 'employee')
        .whereIn('status', REAL_EMPLOYEE_STATUSES as readonly string[])
        .whereIn('department_id', managedDepartmentIds)
        .select('id');
      managedEmployeeIds = managedEmployees.map((u) => u.id);
    }

    const today = new Date();
    const todayStr = formatDateLocal(today);
    const isRangeMode = true;
    const periodStartStr = from_date ?? todayStr;
    const periodEndStr = to_date ?? todayStr;
    const periodStartDate = new Date(periodStartStr);
    const periodEndDate = new Date(periodEndStr);

    const focusDateStr = focus_date ?? periodStartStr;

    // Calculate current week (Monday to Friday) for "This Week" overview
    const focusDate = new Date(focusDateStr);
    const dayOfWeek = focusDate.getDay(); // 0 = Sunday, 1 = Monday, etc.
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek; // Adjust to get Monday
    const mondayDate = new Date(focusDate);
    mondayDate.setDate(focusDate.getDate() + mondayOffset);
    const fridayDate = new Date(mondayDate);
    fridayDate.setDate(mondayDate.getDate() + 4); // Friday is 4 days after Monday

    const weekStartStr = formatDateLocal(mondayDate);
    const weekEndStr = formatDateLocal(fridayDate);

    const [totalEmployeesRow, leaveTypes, monthLeaves] = await Promise.all([
      User.query()
        .where('org_id', org_id)
        .whereIn('role', ['employee', 'manager', 'hr'])
        .whereIn('status', REAL_EMPLOYEE_STATUSES as readonly string[])
        .modify((qb) => {
          if (isManager) {
            qb.whereIn('department_id', managedDepartmentIds);
          }
        })
        .countDistinct('id as count')
        .first(),
      LeaveType.query().where('org_id', org_id),
      LeaveRequest.query()
        .alias('lr')
        .leftJoin('users as u', 'u.id', 'lr.user_id')
        .leftJoin('departments as d', 'd.id', 'u.department_id')
        .where('lr.org_id', org_id)
        .whereIn('u.role', ['employee', 'manager', 'hr'])
        .whereIn('u.status', REAL_EMPLOYEE_STATUSES as readonly string[])
        .whereNull('u.deleted_at')
        .modify((qb) => {
          if (isManager) {
            qb.whereIn('lr.user_id', managedEmployeeIds);
          }
        })
        .where((qb) => {
          // Include APPROVED leaves that overlap with the requested period.
          qb.whereBetween('lr.start_date', [periodStartStr, periodEndStr])
            .orWhereBetween('lr.end_date', [periodStartStr, periodEndStr])
            .orWhere((inner) =>
              inner
                .where('lr.start_date', '<=', periodStartStr)
                .where('lr.end_date', '>=', periodEndStr),
            );
        })
        .where('lr.status', 'APPROVED')
        .select('lr.*', 'u.role', 'u.department_id', 'd.working_days as department_working_days'),
    ]);

    const total_employees = Number(
      (totalEmployeesRow as { count?: string | number } | undefined)?.count ?? 0,
    );

    const typesById = new Map<string, LeaveType>();
    for (const t of leaveTypes) {
      typesById.set(t.id, t);
    }

    const hasExplicitRange = Boolean(from_date && to_date);

    const todayCountsByType = new Map<string, number>();
    const byDayCount = new Map<string, number>();
    const typeTotals = new Map<string, number>();
    const typeEmployeeCounts = new Map<string, Set<string>>(); // Track unique employees per type (period)
    const todayEmployeeCountsByType = new Map<string, Set<string>>(); // Track unique employees per type (today only)
    const uniqueEmployeesOnFocusDate = new Set<string>();
    const uniqueUsersInRange = new Set<string>();

    const employeesOnFocusDateRaw: any[] = [];

    const {
      holidaySet: dashHolidaySet,
      holidaySetByUserId: dashHolidaySetByUserId,
      managedScheduleByManagerId: dashManagedSchedule,
    } = await buildLeaveDaysContextForRows(org_id, monthLeaves as any[]);

    for (const reqRow of monthLeaves as any[]) {
      const type = typesById.get(reqRow.leave_type_id);
      const leaveStartStr = normalizeDate(reqRow.start_date);
      const leaveEndStr = normalizeDate(reqRow.end_date);
      if (!leaveStartStr || !leaveEndStr) {
        continue;
      }

      const schedule = resolveLeaveScheduleForRow(reqRow, dashManagedSchedule);
      const rowHolidaySet = dashHolidaySetByUserId.get(String(reqRow.user_id)) ?? dashHolidaySet;

      let dateStr = leaveStartStr;
      while (dateStr <= leaveEndStr) {
        if (dateStr >= periodStartStr && dateStr <= periodEndStr) {
          if (
            isUserAttendanceScheduledDay({
              dateStr,
              holidaySet: rowHolidaySet,
              departmentId: schedule.departmentId,
              workingDays: schedule.workingDays,
            })
          ) {
            uniqueUsersInRange.add(reqRow.user_id);
            byDayCount.set(dateStr, (byDayCount.get(dateStr) ?? 0) + 1);
            if (type) {
              typeTotals.set(type.id, (typeTotals.get(type.id) ?? 0) + 1);
              if (!typeEmployeeCounts.has(type.id)) {
                typeEmployeeCounts.set(type.id, new Set());
              }
              typeEmployeeCounts.get(type.id)!.add(reqRow.user_id);
            }
          }
        }
        if (dateStr === leaveEndStr) {
          break;
        }
        dateStr = addCalendarDays(dateStr, 1);
      }

      const onLeaveOnFocusDate =
        focusDateStr >= leaveStartStr &&
        focusDateStr <= leaveEndStr &&
        countLeaveDaysForRow({
          row: { ...reqRow, start_date: focusDateStr, end_date: focusDateStr },
          holidaySet: dashHolidaySet,
          holidaySetByUserId: dashHolidaySetByUserId,
          managedScheduleByManagerId: dashManagedSchedule,
        }) > 0;

      if (onLeaveOnFocusDate && type) {
        uniqueEmployeesOnFocusDate.add(reqRow.user_id);
        // Track unique employees per leave type for TODAY (for donut chart)
        if (!todayEmployeeCountsByType.has(type.id)) {
          todayEmployeeCountsByType.set(type.id, new Set());
        }
        todayEmployeeCountsByType.get(type.id)!.add(reqRow.user_id);
        todayCountsByType.set(type.id, todayEmployeeCountsByType.get(type.id)!.size);
        employeesOnFocusDateRaw.push({
          id: reqRow.id,
          user_id: reqRow.user_id,
          leave_type_id: type.id,
          leave_type_name: type.name,
          start_date: leaveStartStr,
          end_date: leaveEndStr,
          status: reqRow.status,
        });
      }
    }

    const totalOnLeaveToday = uniqueEmployeesOnFocusDate.size;
    const totalOnLeaveInRange = uniqueUsersInRange.size;

    const todaySummaryTypes = leaveTypes.map((t) => {
      const count = hasExplicitRange
        ? (typeEmployeeCounts.get(t.id)?.size ?? 0)
        : (todayCountsByType.get(t.id) ?? 0);
      const denom = hasExplicitRange ? totalOnLeaveInRange : totalOnLeaveToday;
      const percentage = denom > 0 ? (count / denom) * 100 : 0;
      return {
        id: t.id,
        name: t.name,
        count,
        percentage: Math.round(percentage * 100) / 100,
      };
    });

    const overviewByDay: Array<{ date: string; count: number }> = [];
    const cursor = new Date(periodStartDate);
    while (cursor <= periodEndDate) {
      const key = formatDateLocal(cursor);
      overviewByDay.push({
        date: key,
        count: byDayCount.get(key) ?? 0,
      });
      cursor.setDate(cursor.getDate() + 1);
    }

    // Build "This Week" overview (Monday to Friday)
    const overviewByWeek: Array<{ date: string; count: number }> = [];
    const weekCursor = new Date(mondayDate);
    while (weekCursor <= fridayDate) {
      const key = formatDateLocal(weekCursor);
      overviewByWeek.push({
        date: key,
        count: byDayCount.get(key) ?? 0,
      });
      weekCursor.setDate(weekCursor.getDate() + 1);
    }

    // Calculate types breakdown with employee counts
    const totalOnLeaveTodayForBreakdown = Array.from(todayCountsByType.values()).reduce(
      (sum, val) => sum + val,
      0,
    );

    const typesBreakdown = leaveTypes.map((t) => {
      const totalDays = typeTotals.get(t.id) ?? 0;
      const rangeEmployeeCount = typeEmployeeCounts.get(t.id)?.size ?? 0; // Unique users on this leave type in range
      const todayCount = todayCountsByType.get(t.id) ?? 0;
      // Percentage of total leave today (for the donut chart)
      const percentage =
        totalOnLeaveTodayForBreakdown > 0 ? (todayCount / totalOnLeaveTodayForBreakdown) * 100 : 0;
      return {
        id: t.id,
        name: t.name,
        total_days: totalDays,
        employee_count: rangeEmployeeCount,
        percentage: Math.round(percentage * 100 * 10) / 10, // Round to 1 decimal place
      };
    });

    // Enrich employeesOnFocusDate with employee details for UI
    const focusUserIds = Array.from(new Set(employeesOnFocusDateRaw.map((e) => e.user_id)));

    let employeesOnFocusDate: any[] = [];
    if (focusUserIds.length > 0) {
      const userRows = await User.query()
        .alias('u')
        .leftJoin('departments', 'departments.id', 'u.department_id')
        .where('u.org_id', org_id)
        .whereIn('u.id', focusUserIds)
        .select(
          'u.id',
          'u.employee_id',
          'u.first_name',
          'u.last_name',
          'u.profile_image_url',
          'u.role',
          'u.designation',
          'departments.id as department_id',
          'departments.name as department_name',
        );

      const userMap = new Map((userRows as any[]).map((r) => [r.id, r]));

      employeesOnFocusDate = employeesOnFocusDateRaw.map((entry) => {
        const user = userMap.get(entry.user_id);
        return {
          id: entry.id,
          start_date: entry.start_date,
          end_date: entry.end_date,
          status: entry.status,
          leave_type: {
            id: entry.leave_type_id,
            name: entry.leave_type_name,
          },
          employee: user
            ? {
                id: user.id,
                employee_id: user.employee_id,
                full_name: `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim(),
                role: user.role,
                designation: user.designation ?? null,
                department: user.department_id
                  ? { id: user.department_id, name: user.department_name }
                  : null,
                profile_image_url: user.profile_image_url ?? null,
              }
            : null,
        };
      });
    }

    // Get public holidays for the month (placeholder - can be extended with a public_holidays table)
    const publicHolidays: string[] = []; // TODO: Query from public_holidays table if exists

    return res.json({
      month: null,
      year: null,
      from_date: periodStartStr,
      to_date: periodEndStr,
      filter_mode: isRangeMode ? 'DATE_RANGE' : 'MONTH_YEAR',
      focus_date: focusDateStr,
      summary_today: {
        total_employees,
        total_on_leave: hasExplicitRange ? totalOnLeaveInRange : totalOnLeaveToday,
        percentage_on_leave:
          total_employees > 0
            ? Math.round(
                ((hasExplicitRange ? totalOnLeaveInRange : totalOnLeaveToday) / total_employees) *
                  100 *
                  100,
              ) / 100
            : 0,
        by_type: todaySummaryTypes,
      },
      overview: {
        by_day: overviewByDay, // Monthly calendar data
        by_week: overviewByWeek, // This Week (Mon-Fri) data for the chart
        week_range: {
          start_date: weekStartStr,
          end_date: weekEndStr,
        },
      },
      employee_leaves_on_focus_date: employeesOnFocusDate,
      types_breakdown: typesBreakdown,
      public_holidays: publicHolidays, // Array of dates (YYYY-MM-DD) that are public holidays
    });
  }
}
