import { raw } from 'objection';

import { ACTIVE_USER_EXIT_STATUSES, EXIT_PROTECTED_ROLES } from '../constants/user-exit';
import { AttendanceCorrectionRequest } from '../models/AttendanceCorrectionRequest';
import { Department } from '../models/Department';
import { HelpdeskTicket } from '../models/HelpdeskTicket';
import { LeaveRequest } from '../models/LeaveRequest';
import { ReimbursementRequest } from '../models/ReimbursementRequest';
import { PasswordResetToken } from '../models/PasswordResetToken';
import { RefreshToken } from '../models/RefreshToken';
import { User } from '../models/User';
import { UserDeviceToken } from '../models/UserDeviceToken';
import { UserExit, type UserExitType } from '../models/UserExit';
import { ACTIVITY_ENTITY_TYPES, ACTIVITY_TYPES, ActivityLogService } from './activity-log.service';
import { logger } from '../config/logger';
import { getManagedDepartmentIds } from '../utils/department-manager.utils';
import { formatDateLocal, getTodayDate } from '../utils/date.utils';

export type ExitPreview = {
  user: { id: string; status: string; role: string };
  warnings: {
    pending_leave_requests: number;
    pending_reimbursement_requests: number;
    pending_attendance_corrections: number;
    open_helpdesk_tickets: number;
    managed_departments: Array<{ id: string; name: string }>;
  };
  active_exit: ReturnType<typeof mapExitResponse> | null;
};

const mapExitResponse = (exit: UserExit) => ({
  id: exit.id,
  user_id: exit.user_id,
  exit_type: exit.exit_type,
  exit_reason: exit.exit_reason ?? null,
  notice_start_date: exit.notice_start_date ?? null,
  last_working_day: exit.last_working_day,
  exited_at: exit.exited_at ?? null,
  status: exit.status,
  initiated_by: exit.initiated_by ?? null,
  confirmed_by: exit.confirmed_by ?? null,
  cancelled_by: exit.cancelled_by ?? null,
  initiated_at: exit.initiated_at,
  confirmed_at: exit.confirmed_at ?? null,
  cancelled_at: exit.cancelled_at ?? null,
});

export class EmployeeExitService {
  static async loadTargetUser(orgId: string, userId: string): Promise<User> {
    const user = await User.query()
      .where({ org_id: orgId, id: userId })
      .whereNull('deleted_at')
      .first();

    if (!user) {
      throw new EmployeeExitError('Employee not found', 404);
    }

    return user;
  }

  static assertCanExit(user: User): void {
    if (EXIT_PROTECTED_ROLES.includes(user.role as (typeof EXIT_PROTECTED_ROLES)[number])) {
      throw new EmployeeExitError(`Cannot initiate exit for role: ${user.role}`, 400);
    }
  }

  static async getActiveExit(orgId: string, userId: string): Promise<UserExit | undefined> {
    return UserExit.query()
      .where({ org_id: orgId, user_id: userId })
      .whereIn('status', [...ACTIVE_USER_EXIT_STATUSES])
      .orderBy('created_at', 'desc')
      .first();
  }

  static async previewExit(orgId: string, userId: string): Promise<ExitPreview> {
    const user = await this.loadTargetUser(orgId, userId);

    if (user.status === 'INACTIVE') {
      throw new EmployeeExitError('Employee is already inactive', 400);
    }

    const activeExit = await this.getActiveExit(orgId, userId);
    if (activeExit?.status === 'COMPLETED') {
      throw new EmployeeExitError('Employee exit is already completed', 400);
    }

    const [pendingLeave, pendingReimbursement, pendingAttendance, openHelpdesk] = await Promise.all(
      [
        LeaveRequest.query()
          .where({ org_id: orgId, user_id: userId, status: 'PENDING' })
          .resultSize(),
        ReimbursementRequest.query()
          .where({ org_id: orgId, user_id: userId, status: 'PENDING' })
          .resultSize(),
        AttendanceCorrectionRequest.query()
          .where({ user_id: userId })
          .where((b) => {
            b.where('status', 'PENDING')
              .orWhere('manager_status', 'PENDING')
              .orWhere('hr_status', 'PENDING');
          })
          .resultSize(),
        HelpdeskTicket.query()
          .where({ org_id: orgId, created_by: userId })
          .whereIn('status', ['OPEN', 'IN_PROGRESS', 'REOPENED'])
          .resultSize(),
      ],
    );

    let managedDepartments: Array<{ id: string; name: string }> = [];
    if (user.role === 'manager') {
      const deptIds = await getManagedDepartmentIds(orgId, userId);
      if (deptIds.length > 0) {
        managedDepartments = await Department.query()
          .where('org_id', orgId)
          .whereIn('id', deptIds)
          .select('id', 'name');
      }
    }

    return {
      user: { id: user.id, status: user.status, role: user.role },
      warnings: {
        pending_leave_requests: pendingLeave,
        pending_reimbursement_requests: pendingReimbursement,
        pending_attendance_corrections: pendingAttendance,
        open_helpdesk_tickets: openHelpdesk,
        managed_departments: managedDepartments,
      },
      active_exit: activeExit ? mapExitResponse(activeExit) : null,
    };
  }

  static async getCurrentExit(orgId: string, userId: string) {
    await this.loadTargetUser(orgId, userId);
    const activeExit = await this.getActiveExit(orgId, userId);
    return activeExit ? mapExitResponse(activeExit) : null;
  }

  static async initiateExit(
    orgId: string,
    userId: string,
    actorUserId: string,
    input: {
      exit_type: UserExitType;
      exit_reason?: string | null;
      notice_start_date?: string | null;
      last_working_day: string;
    },
  ) {
    const user = await this.loadTargetUser(orgId, userId);
    this.assertCanExit(user);

    if (user.status === 'INACTIVE') {
      throw new EmployeeExitError('Employee is already inactive', 400);
    }

    const existing = await this.getActiveExit(orgId, userId);
    if (existing) {
      throw new EmployeeExitError('An active exit process already exists for this employee', 400);
    }

    const today = formatDateLocal(new Date());

    if (input.last_working_day < today) {
      const completed = await this.completeExitImmediately(orgId, userId, actorUserId, {
        exit_type: input.exit_type,
        exit_reason: input.exit_reason,
        last_working_day: input.last_working_day,
        notice_start_date: input.notice_start_date,
      });

      await ActivityLogService.recordActivitySafely({
        org_id: orgId,
        actor_user_id: actorUserId,
        target_user_id: userId,
        entity_type: ACTIVITY_ENTITY_TYPES.USER,
        entity_id: completed.id,
        activity_type: ACTIVITY_TYPES.EXIT_CONFIRMED,
        metadata: {
          completed_on_initiate: true,
          last_working_day: input.last_working_day,
          exited_at: completed.exited_at,
        },
      });

      return mapExitResponse(completed);
    }

    const noticeStart = input.notice_start_date ?? null;
    const now = new Date();

    if (noticeStart && noticeStart > today) {
      const exit = await UserExit.query().insert({
        org_id: orgId,
        user_id: userId,
        exit_type: input.exit_type,
        exit_reason: input.exit_reason ?? null,
        notice_start_date: noticeStart,
        last_working_day: input.last_working_day,
        status: 'SCHEDULED',
        initiated_by: actorUserId,
        initiated_at: now,
      } as any);

      await ActivityLogService.recordActivitySafely({
        org_id: orgId,
        actor_user_id: actorUserId,
        target_user_id: userId,
        entity_type: ACTIVITY_ENTITY_TYPES.USER,
        entity_id: exit.id,
        activity_type: ACTIVITY_TYPES.EXIT_SCHEDULED,
        metadata: {
          exit_type: input.exit_type,
          notice_start_date: noticeStart,
          last_working_day: input.last_working_day,
        },
      });

      return mapExitResponse(exit);
    }

    const exit = await User.transaction(async (trx) => {
      const row = await UserExit.query(trx).insert({
        org_id: orgId,
        user_id: userId,
        exit_type: input.exit_type,
        exit_reason: input.exit_reason ?? null,
        notice_start_date: input.notice_start_date ?? null,
        last_working_day: input.last_working_day,
        status: 'ON_NOTICE',
        initiated_by: actorUserId,
        initiated_at: now,
      } as any);

      await User.query(trx).patchAndFetchById(userId, { status: 'ON_NOTICE' });

      return row;
    });

    await ActivityLogService.recordActivitySafely({
      org_id: orgId,
      actor_user_id: actorUserId,
      target_user_id: userId,
      entity_type: ACTIVITY_ENTITY_TYPES.USER,
      entity_id: exit.id,
      activity_type: ACTIVITY_TYPES.EXIT_INITIATED,
      metadata: {
        exit_type: input.exit_type,
        last_working_day: input.last_working_day,
        notice_start_date: input.notice_start_date ?? null,
      },
    });

    return mapExitResponse(exit);
  }

  static async updateExit(
    orgId: string,
    userId: string,
    input: {
      exit_type?: UserExitType;
      exit_reason?: string | null;
      notice_start_date?: string | null;
      last_working_day?: string;
    },
  ) {
    await this.loadTargetUser(orgId, userId);

    const exit = await this.getActiveExit(orgId, userId);
    if (!exit || (exit.status !== 'ON_NOTICE' && exit.status !== 'SCHEDULED')) {
      throw new EmployeeExitError('No active exit found to update', 404);
    }

    const patch: Record<string, unknown> = {};
    if (input.exit_type !== undefined) patch.exit_type = input.exit_type;
    if (input.exit_reason !== undefined) patch.exit_reason = input.exit_reason;
    if (input.notice_start_date !== undefined) patch.notice_start_date = input.notice_start_date;
    if (input.last_working_day !== undefined) patch.last_working_day = input.last_working_day;

    if (Object.keys(patch).length === 0) {
      throw new EmployeeExitError('No fields to update', 400);
    }

    const updated = await UserExit.query().patchAndFetchById(exit.id, patch as any);

    if (updated.status === 'SCHEDULED' && updated.notice_start_date) {
      const today = formatDateLocal(new Date());
      if (updated.notice_start_date <= today) {
        const started = await this.startNoticePeriod(orgId, userId, updated);
        if (started) {
          return mapExitResponse(started);
        }
      }
    }

    return mapExitResponse(updated);
  }

  static async confirmExit(orgId: string, userId: string, actorUserId: string) {
    const user = await this.loadTargetUser(orgId, userId);

    if (user.status !== 'ON_NOTICE') {
      throw new EmployeeExitError('Employee must be on notice to confirm exit', 400);
    }

    const exit = await this.getActiveExit(orgId, userId);
    if (!exit || exit.status !== 'ON_NOTICE') {
      throw new EmployeeExitError('No active notice-period exit found', 404);
    }

    const completed = await this.finalizeNoticePeriodExit(
      orgId,
      userId,
      exit,
      actorUserId,
      'manual',
    );

    if (!completed) {
      throw new EmployeeExitError('No active notice-period exit found', 404);
    }

    return mapExitResponse(completed);
  }

  static async processDueNoticeStarts(
    referenceDate?: Date,
  ): Promise<{ processed: number; failed: number }> {
    const today = formatDateLocal(referenceDate ?? new Date());

    const dueExits = await UserExit.query()
      .alias('ue')
      .innerJoin('users as u', 'u.id', 'ue.user_id')
      .where('ue.status', 'SCHEDULED')
      .where('u.status', 'ACTIVE')
      .whereNull('u.deleted_at')
      .whereNotNull('ue.notice_start_date')
      .whereRaw('ue.notice_start_date::date <= ?::date', [today])
      .select('ue.*');

    let processed = 0;
    let failed = 0;

    for (const exit of dueExits) {
      try {
        const started = await this.startNoticePeriod(exit.org_id, exit.user_id, exit);
        if (started) {
          processed += 1;
        }
      } catch (err) {
        failed += 1;
        logger.error(
          { err, exitId: exit.id, userId: exit.user_id, orgId: exit.org_id },
          'Auto notice start failed for employee',
        );
      }
    }

    return { processed, failed };
  }

  static async processDueAutoExits(
    referenceDate?: Date,
  ): Promise<{ processed: number; failed: number }> {
    const today = formatDateLocal(referenceDate ?? new Date());

    const dueExits = await UserExit.query()
      .alias('ue')
      .innerJoin('users as u', 'u.id', 'ue.user_id')
      .where('ue.status', 'ON_NOTICE')
      .where('u.status', 'ON_NOTICE')
      .whereNull('u.deleted_at')
      .whereRaw('ue.last_working_day::date < ?::date', [today])
      .select('ue.*');

    let processed = 0;
    let failed = 0;

    for (const exit of dueExits) {
      try {
        const completed = await this.finalizeNoticePeriodExit(
          exit.org_id,
          exit.user_id,
          exit,
          null,
          'auto',
        );
        if (completed) {
          processed += 1;
        }
      } catch (err) {
        failed += 1;
        logger.error(
          { err, exitId: exit.id, userId: exit.user_id, orgId: exit.org_id },
          'Auto exit confirm failed for employee',
        );
      }
    }

    return { processed, failed };
  }

  static async immediateExit(
    orgId: string,
    userId: string,
    actorUserId: string,
    input: {
      exit_type: UserExitType;
      exit_reason?: string | null;
      last_working_day?: string;
    },
  ) {
    const user = await this.loadTargetUser(orgId, userId);
    this.assertCanExit(user);

    if (user.status === 'INACTIVE') {
      throw new EmployeeExitError('Employee is already inactive', 400);
    }

    const existing = await this.getActiveExit(orgId, userId);
    if (existing) {
      throw new EmployeeExitError('An active exit process already exists for this employee', 400);
    }

    const lastWorkingDay = input.last_working_day ?? getTodayDate();

    const completed = await this.completeExitImmediately(orgId, userId, actorUserId, {
      exit_type: input.exit_type,
      exit_reason: input.exit_reason,
      last_working_day: lastWorkingDay,
    });

    await ActivityLogService.recordActivitySafely({
      org_id: orgId,
      actor_user_id: actorUserId,
      target_user_id: userId,
      entity_type: ACTIVITY_ENTITY_TYPES.USER,
      entity_id: completed.id,
      activity_type: ACTIVITY_TYPES.EXIT_IMMEDIATE,
      metadata: {
        exit_type: input.exit_type,
        last_working_day: lastWorkingDay,
        exited_at: completed.exited_at,
      },
    });

    return mapExitResponse(completed);
  }

  static async cancelExit(orgId: string, userId: string, actorUserId: string) {
    await this.loadTargetUser(orgId, userId);

    const exit = await this.getActiveExit(orgId, userId);
    if (!exit || (exit.status !== 'ON_NOTICE' && exit.status !== 'SCHEDULED')) {
      throw new EmployeeExitError('No active exit found to cancel', 404);
    }

    const now = new Date();

    const cancelled = await User.transaction(async (trx) => {
      const row = await UserExit.query(trx).patchAndFetchById(exit.id, {
        status: 'CANCELLED',
        cancelled_at: now,
        cancelled_by: actorUserId,
      } as any);

      if (exit.status === 'ON_NOTICE') {
        await User.query(trx).patchAndFetchById(userId, { status: 'ACTIVE' });
      }

      return row;
    });

    await ActivityLogService.recordActivitySafely({
      org_id: orgId,
      actor_user_id: actorUserId,
      target_user_id: userId,
      entity_type: ACTIVITY_ENTITY_TYPES.USER,
      entity_id: cancelled.id,
      activity_type: ACTIVITY_TYPES.EXIT_CANCELLED,
    });

    return mapExitResponse(cancelled);
  }

  private static async startNoticePeriod(
    orgId: string,
    userId: string,
    exit: UserExit,
  ): Promise<UserExit | null> {
    const started = await User.transaction(async (trx) => {
      const row = await UserExit.query(trx)
        .patch({ status: 'ON_NOTICE' } as any)
        .where('id', exit.id)
        .where('status', 'SCHEDULED')
        .returning('*')
        .first();

      if (!row) {
        return null;
      }

      await User.query(trx).patchAndFetchById(userId, { status: 'ON_NOTICE' });

      return row;
    });

    if (!started) {
      return null;
    }

    await ActivityLogService.recordActivitySafely({
      org_id: orgId,
      actor_user_id: null,
      target_user_id: userId,
      entity_type: ACTIVITY_ENTITY_TYPES.USER,
      entity_id: started.id,
      activity_type: ACTIVITY_TYPES.EXIT_NOTICE_STARTED,
      metadata: {
        notice_start_date: started.notice_start_date,
        last_working_day: started.last_working_day,
      },
    });

    return started;
  }

  private static async completeExitImmediately(
    orgId: string,
    userId: string,
    actorUserId: string,
    input: {
      exit_type: UserExitType;
      exit_reason?: string | null;
      last_working_day: string;
      notice_start_date?: string | null;
    },
  ): Promise<UserExit> {
    const now = new Date();
    const nowIso = now.toISOString();

    return User.transaction(async (trx) => {
      const row = await UserExit.query(trx).insert({
        org_id: orgId,
        user_id: userId,
        exit_type: input.exit_type,
        exit_reason: input.exit_reason ?? null,
        notice_start_date: input.notice_start_date ?? null,
        last_working_day: input.last_working_day,
        status: 'COMPLETED',
        exited_at: now,
        initiated_by: actorUserId,
        confirmed_by: actorUserId,
        initiated_at: now,
        confirmed_at: now,
      } as any);

      await User.query(trx).patchAndFetchById(userId, { status: 'INACTIVE' });

      await this.revokeAccess(trx, orgId, userId, nowIso);
      await this.rejectFuturePendingLeave(trx, orgId, userId, input.last_working_day);

      return row;
    });
  }

  private static async finalizeNoticePeriodExit(
    orgId: string,
    userId: string,
    exit: UserExit,
    confirmedBy: string | null,
    source: 'manual' | 'auto',
  ): Promise<UserExit | null> {
    const now = new Date();
    const nowIso = now.toISOString();

    const completed = await User.transaction(async (trx) => {
      const row = await UserExit.query(trx)
        .patch({
          status: 'COMPLETED',
          exited_at: now,
          confirmed_at: now,
          confirmed_by: confirmedBy,
        } as any)
        .where('id', exit.id)
        .where('status', 'ON_NOTICE')
        .returning('*')
        .first();

      if (!row) {
        return null;
      }

      await User.query(trx).patchAndFetchById(userId, { status: 'INACTIVE' });

      await this.revokeAccess(trx, orgId, userId, nowIso);
      await this.rejectFuturePendingLeave(trx, orgId, userId, exit.last_working_day);

      return row;
    });

    if (!completed) {
      return null;
    }

    const activityType =
      source === 'auto' ? ACTIVITY_TYPES.EXIT_AUTO_CONFIRMED : ACTIVITY_TYPES.EXIT_CONFIRMED;

    await ActivityLogService.recordActivitySafely({
      org_id: orgId,
      actor_user_id: confirmedBy,
      target_user_id: userId,
      entity_type: ACTIVITY_ENTITY_TYPES.USER,
      entity_id: completed.id,
      activity_type: activityType,
      metadata:
        source === 'auto'
          ? { auto: true, last_working_day: exit.last_working_day, exited_at: nowIso }
          : { exited_at: nowIso },
    });

    return completed;
  }

  private static async revokeAccess(
    trx: import('objection').Transaction,
    orgId: string,
    userId: string,
    nowIso: string,
  ): Promise<void> {
    await RefreshToken.query(trx)
      .patch({ revoked_at: nowIso })
      .where('subject_type', 'tenant')
      .where('subject_id', userId)
      .where('org_id', orgId)
      .whereNull('revoked_at');

    await PasswordResetToken.query(trx)
      .patch({ consumed_at: nowIso })
      .where({ user_id: userId })
      .whereNull('consumed_at');

    await UserDeviceToken.query(trx).patch({ enabled: false }).where({ user_id: userId });
  }

  private static async rejectFuturePendingLeave(
    trx: import('objection').Transaction,
    orgId: string,
    userId: string,
    lastWorkingDay: string,
  ): Promise<void> {
    await LeaveRequest.query(trx)
      .patch({ status: 'REJECTED' })
      .where({ org_id: orgId, user_id: userId, status: 'PENDING' })
      .where(raw('start_date::date > ?::date', [lastWorkingDay]));
  }
}

export class EmployeeExitError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}
