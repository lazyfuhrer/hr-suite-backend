import { User } from '../../models/User';
import { NotificationAutomationLog } from '../../models/NotificationAutomationLog';
import { LeaveType } from '../../models/LeaveType';
import { LeaveRequest } from '../../models/LeaveRequest';
import { DepartmentManager } from '../../models/DepartmentManager';
import { ATTENDANCE_ACTIVE_EMPLOYEE_STATUSES } from '../../constants/user-status';
import { logger } from '../../config/logger';
import { dispatchNotificationEvent } from './notification-dispatcher.service';
import { getNotificationSettings } from './notification-settings.service';

const IST_TIMEZONE = 'Asia/Kolkata';

type LeaveDateInput = string | Date | null | undefined;

function formatLeaveDateIST(input: LeaveDateInput): string {
  if (!input) return '';

  let date: Date | null = null;
  if (input instanceof Date) {
    date = input;
  } else if (typeof input === 'string') {
    const raw = input.trim();
    // If it's a plain YYYY-MM-DD, treat it as an IST calendar date.
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      // 00:00 IST == 18:30Z of previous day; using this avoids day shift when formatting in IST.
      date = new Date(`${raw}T00:00:00+05:30`);
    } else {
      const parsed = new Date(raw);
      if (!Number.isNaN(parsed.getTime())) {
        date = parsed;
      }
    }
  }

  if (!date || Number.isNaN(date.getTime())) {
    if (typeof input === 'string') {
      const s = input.trim();
      return s.length >= 10 ? s.slice(0, 10) : s;
    }
    return '';
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: IST_TIMEZONE,
    weekday: 'short',
    month: 'short',
    day: '2-digit',
    year: 'numeric',
  }).formatToParts(date);

  const pick = (type: string) => parts.find((p) => p.type === type)?.value;
  const weekday = pick('weekday');
  const month = pick('month');
  const day = pick('day');
  const year = pick('year');

  if (!weekday || !month || !day || !year) {
    // Fallback: still ensure we don't include time/timezone.
    return new Intl.DateTimeFormat('en-US', {
      timeZone: IST_TIMEZONE,
      weekday: 'short',
      month: 'short',
      day: '2-digit',
      year: 'numeric',
    }).format(date);
  }

  // Match desired format: "Thu Aug 23 2035"
  return `${weekday} ${month} ${day} ${year}`;
}

const buildLeaveDates = (startDate: LeaveDateInput, endDate: LeaveDateInput): string => {
  const start = formatLeaveDateIST(startDate);
  const end = formatLeaveDateIST(endDate);
  return start === end ? start : `${start} to ${end}`;
};

/** Skip only when a prior send definitively succeeded (avoids blocking HR final notify after a failed/partial attempt). */
async function leaveNotificationEventSucceeded(eventKey: string): Promise<boolean> {
  const row = await NotificationAutomationLog.query()
    .where('event_key', eventKey)
    .whereIn('status', ['SENT', 'READ', 'DISMISSED'])
    .where('success_count', '>', 0)
    .first();
  return Boolean(row);
}

/** Remove non-final log rows so a retry can insert the same event_key again. */
async function clearRetriableLeaveNotificationLogs(eventKey: string): Promise<void> {
  await NotificationAutomationLog.query()
    .delete()
    .where('event_key', eventKey)
    .where((qb) => {
      qb.where('status', 'PENDING').orWhere((inner) => {
        inner.whereIn('status', ['SENT', 'READ', 'DISMISSED']).where('success_count', '<=', 0);
      });
    });
}

async function createPendingEventLog(args: {
  orgId: string;
  subjectUserId: string;
  ruleKey: string;
  eventKey: string;
  meta: Record<string, unknown>;
}) {
  return await NotificationAutomationLog.query().insert({
    org_id: args.orgId,
    subject_user_id: args.subjectUserId,
    rule_key: args.ruleKey,
    event_key: args.eventKey,
    status: 'PENDING',
    trigger_time: new Date().toISOString(),
    meta: args.meta,
  });
}

async function markEventSent(args: {
  logId: string;
  audienceCount: number;
  successCount: number;
  failureCount: number;
}) {
  await NotificationAutomationLog.query().patchAndFetchById(args.logId, {
    status: 'SENT',
    sent_at: new Date().toISOString(),
    audience_count: args.audienceCount,
    success_count: args.successCount,
    failure_count: args.failureCount,
  });
}

export async function notifyLeaveSubmitted(args: {
  orgId: string;
  leaveRequestId: string;
  applicantUserId: string;
  managerId: string | null;
  leaveTypeId: string;
  startDate: string;
  endDate: string;
}) {
  const settings = await getNotificationSettings(args.orgId);
  if (!settings.enabled_leave_submitted_notifications) return;

  const eventKey = `${args.orgId}:leave_submitted:${args.leaveRequestId}`;
  if (await leaveNotificationEventSucceeded(eventKey)) return;

  const [applicant, leaveType, hrUsers] = await Promise.all([
    User.query()
      .findById(args.applicantUserId)
      .select('id', 'first_name', 'last_name', 'department_id'),
    LeaveType.query().findById(args.leaveTypeId).select('id', 'name'),
    User.query()
      .where('org_id', args.orgId)
      .where('role', 'hr')
      .whereIn('status', ATTENDANCE_ACTIVE_EMPLOYEE_STATUSES as readonly string[])
      .whereNull('deleted_at')
      .select('id'),
  ]);

  if (!applicant || !leaveType) return;

  const applicantName =
    `${(applicant as any).first_name ?? ''} ${(applicant as any).last_name ?? ''}`.trim();

  const applicantDeptId = (applicant as any).department_id
    ? String((applicant as any).department_id)
    : null;
  const deptManagerIds = applicantDeptId
    ? (
        await DepartmentManager.query()
          .alias('dm')
          .innerJoin('departments as d', 'd.id', 'dm.department_id')
          .where('d.org_id', args.orgId)
          .whereNull('d.deleted_at')
          .where('dm.department_id', applicantDeptId)
          .select('dm.manager_id')
      )?.map((r: any) => String(r.manager_id))
    : [];

  const candidateRecipientIds = Array.from(
    new Set([
      ...(args.managerId ? [args.managerId] : []),
      ...deptManagerIds,
      ...hrUsers.map((u) => u.id),
    ]),
  ).filter((id) => id !== args.applicantUserId);

  const activeRecipients =
    candidateRecipientIds.length > 0
      ? await User.query()
          .whereIn('id', candidateRecipientIds)
          .whereIn('status', ATTENDANCE_ACTIVE_EMPLOYEE_STATUSES as readonly string[])
          .whereNull('deleted_at')
          .select('id')
      : [];
  const recipientIds = activeRecipients.map((u) => u.id);
  if (recipientIds.length === 0) return;

  await clearRetriableLeaveNotificationLogs(eventKey);

  const pending = await createPendingEventLog({
    orgId: args.orgId,
    subjectUserId: args.applicantUserId,
    ruleKey: 'leave_submitted',
    eventKey,
    meta: {
      leave_request_id: args.leaveRequestId,
      leave_type_id: args.leaveTypeId,
      recipients: recipientIds,
    },
  });

  const result = await dispatchNotificationEvent({
    event: 'automation.leave_submitted',
    scope: 'user',
    orgId: args.orgId,
    userIds: recipientIds,
    title: 'New leave request submitted 📝',
    body: `${applicantName} has requested ${leaveType.name} for ${buildLeaveDates(args.startDate, args.endDate)}. Please review and take action.`,
    data: {
      leaveRequestId: args.leaveRequestId,
      leaveType: leaveType.name,
      leaveDates: buildLeaveDates(args.startDate, args.endDate),
      leaveApplicantName: applicantName,
    },
  });

  /* Leave submitted delivery logs (re-enable when debugging)
  if (result.successCount > 0) {
    logger.info(
      {
        org_id: args.orgId,
        leave_request_id: args.leaveRequestId,
        audience_count: recipientIds.length,
        success_count: result.successCount,
        failure_count: result.failureCount,
        invalid_token_count: result.invalidTokens?.length ?? 0,
      },
      'Leave submitted notification delivered',
    );
  } else {
    logger.warn(
      {
        org_id: args.orgId,
        leave_request_id: args.leaveRequestId,
        audience_count: recipientIds.length,
        success_count: result.successCount,
        failure_count: result.failureCount,
        invalid_token_count: result.invalidTokens?.length ?? 0,
      },
      'Leave submitted notification delivery failed (no successful deliveries)',
    );
  }
  */

  await markEventSent({
    logId: pending.id,
    audienceCount: recipientIds.length,
    successCount: result.successCount,
    failureCount: result.failureCount,
  });
}

export async function notifyLeaveStatusChanged(args: {
  orgId: string;
  leaveRequestId: string;
  employeeUserId: string;
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  status: 'APPROVED' | 'REJECTED';
}) {
  const settings = await getNotificationSettings(args.orgId);
  if (!settings.enabled_leave_status_notifications) {
    return;
  }

  const eventKey = `${args.orgId}:leave_status:${args.leaveRequestId}:${args.status}`;
  if (await leaveNotificationEventSucceeded(eventKey)) {
    return;
  }

  const employeeUserId = String(args.employeeUserId ?? '').trim();
  if (!employeeUserId) {
    logger.warn(
      { orgId: args.orgId, leaveRequestId: args.leaveRequestId },
      'notifyLeaveStatusChanged: missing employeeUserId',
    );
    return;
  }

  const employee = await User.query()
    .findById(employeeUserId)
    .select('id', 'first_name', 'last_name', 'status');
  if (!employee) {
    logger.warn(
      { orgId: args.orgId, leaveRequestId: args.leaveRequestId, employeeUserId },
      'notifyLeaveStatusChanged: applicant user not found',
    );
    return;
  }
  if ((employee as any).status === 'INACTIVE') {
    return;
  }

  const primaryLeaveType = await LeaveType.query().findById(args.leaveTypeId).select('name');
  let leaveTypeName = primaryLeaveType?.name ?? null;
  if (!leaveTypeName) {
    const lr = await LeaveRequest.query()
      .findById(args.leaveRequestId)
      .where('org_id', args.orgId)
      .withGraphJoined('leaveType');
    const joinedName = (lr as { leaveType?: { name?: string } | null })?.leaveType?.name;
    leaveTypeName = joinedName ?? 'Leave';
    if (!joinedName) {
      logger.warn(
        {
          orgId: args.orgId,
          leaveRequestId: args.leaveRequestId,
          leaveTypeId: args.leaveTypeId,
        },
        'notifyLeaveStatusChanged: leave type row missing; using fallback label',
      );
    }
  }

  const employeeName =
    `${(employee as any).first_name ?? ''} ${(employee as any).last_name ?? ''}`.trim();

  await clearRetriableLeaveNotificationLogs(eventKey);

  const pending = await createPendingEventLog({
    orgId: args.orgId,
    subjectUserId: employeeUserId,
    ruleKey: 'leave_status_changed',
    eventKey,
    meta: {
      leave_request_id: args.leaveRequestId,
      leave_type_id: args.leaveTypeId,
      status: args.status,
    },
  });

  const approved = args.status === 'APPROVED';
  const result = await dispatchNotificationEvent({
    event: approved ? 'automation.leave_approved' : 'automation.leave_rejected',
    scope: 'user',
    orgId: args.orgId,
    userIds: [employeeUserId],
    title: approved ? 'Your leave request was approved ✅' : 'Your leave request was declined ❌',
    body: approved
      ? `Hi ${employeeName}, your ${leaveTypeName} leave for ${buildLeaveDates(args.startDate, args.endDate)} has been approved.`
      : `Hi ${employeeName}, your ${leaveTypeName} leave for ${buildLeaveDates(args.startDate, args.endDate)} was not approved. Please contact your manager or HR.`,
    data: {
      leaveRequestId: args.leaveRequestId,
      leaveType: leaveTypeName,
      leaveDates: buildLeaveDates(args.startDate, args.endDate),
      employeeName,
      status: args.status,
    },
  });

  /* Leave status delivery logs (re-enable when debugging)
  const logPayload = {
    org_id: args.orgId,
    leave_request_id: args.leaveRequestId,
    status: args.status,
    audience_count: 1,
    success_count: result.successCount,
    failure_count: result.failureCount,
    invalid_token_count: result.invalidTokens?.length ?? 0,
  };
  if (result.successCount > 0) {
    logger.info(logPayload, 'Leave status notification delivered');
  } else {
    logger.warn(logPayload, 'Leave status notification delivery failed (no successful deliveries)');
  }
  */

  await markEventSent({
    logId: pending.id,
    audienceCount: 1,
    successCount: result.successCount,
    failureCount: result.failureCount,
  });
}

export async function notifyLeaveCancelled(args: {
  orgId: string;
  leaveRequestId: string;
  employeeUserId: string;
  leaveTypeId: string;
  startDate: string;
  endDate: string;
}) {
  const settings = await getNotificationSettings(args.orgId);
  if (!settings.enabled_leave_status_notifications) {
    return;
  }

  const eventKey = `${args.orgId}:leave_status:${args.leaveRequestId}:CANCELLED`;
  if (await leaveNotificationEventSucceeded(eventKey)) {
    return;
  }

  const employeeUserId = String(args.employeeUserId ?? '').trim();
  if (!employeeUserId) {
    logger.warn(
      { orgId: args.orgId, leaveRequestId: args.leaveRequestId },
      'notifyLeaveCancelled: missing employeeUserId',
    );
    return;
  }

  const employee = await User.query()
    .findById(employeeUserId)
    .select('id', 'first_name', 'last_name', 'status');
  if (!employee) {
    logger.warn(
      { orgId: args.orgId, leaveRequestId: args.leaveRequestId, employeeUserId },
      'notifyLeaveCancelled: applicant user not found',
    );
    return;
  }
  if ((employee as any).status === 'INACTIVE') {
    return;
  }

  const primaryLeaveType = await LeaveType.query().findById(args.leaveTypeId).select('name');
  let leaveTypeName = primaryLeaveType?.name ?? null;
  if (!leaveTypeName) {
    const lr = await LeaveRequest.query()
      .findById(args.leaveRequestId)
      .where('org_id', args.orgId)
      .withGraphJoined('leaveType');
    const joinedName = (lr as { leaveType?: { name?: string } | null })?.leaveType?.name;
    leaveTypeName = joinedName ?? 'Leave';
    if (!joinedName) {
      logger.warn(
        {
          orgId: args.orgId,
          leaveRequestId: args.leaveRequestId,
          leaveTypeId: args.leaveTypeId,
        },
        'notifyLeaveCancelled: leave type row missing; using fallback label',
      );
    }
  }

  const employeeName =
    `${(employee as any).first_name ?? ''} ${(employee as any).last_name ?? ''}`.trim();

  await clearRetriableLeaveNotificationLogs(eventKey);

  const pending = await createPendingEventLog({
    orgId: args.orgId,
    subjectUserId: employeeUserId,
    ruleKey: 'leave_status_changed',
    eventKey,
    meta: {
      leave_request_id: args.leaveRequestId,
      leave_type_id: args.leaveTypeId,
      status: 'CANCELLED',
    },
  });

  const leaveDates = buildLeaveDates(args.startDate, args.endDate);
  const result = await dispatchNotificationEvent({
    event: 'automation.leave_cancelled',
    scope: 'user',
    orgId: args.orgId,
    userIds: [employeeUserId],
    title: 'Your leave request was cancelled',
    body: `Hi ${employeeName}, your ${leaveTypeName} leave for ${leaveDates} has been cancelled.`,
    data: {
      leaveRequestId: args.leaveRequestId,
      leaveType: leaveTypeName,
      leaveDates,
      employeeName,
      status: 'CANCELLED',
    },
  });

  await markEventSent({
    logId: pending.id,
    audienceCount: 1,
    successCount: result.successCount,
    failureCount: result.failureCount,
  });
}
