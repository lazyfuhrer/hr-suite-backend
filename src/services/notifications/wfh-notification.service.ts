import { User } from '../../models/User';
import { NotificationAutomationLog } from '../../models/NotificationAutomationLog';
import { DepartmentManager } from '../../models/DepartmentManager';
import { ATTENDANCE_ACTIVE_EMPLOYEE_STATUSES } from '../../constants/user-status';
import { logger } from '../../config/logger';
import { dispatchNotificationEvent } from './notification-dispatcher.service';
import { getNotificationSettings } from './notification-settings.service';

const IST_TIMEZONE = 'Asia/Kolkata';

type WfhDateInput = string | Date | null | undefined;

function formatWfhDateIST(input: WfhDateInput): string {
  if (!input) return '';

  let date: Date | null = null;
  if (input instanceof Date) {
    date = input;
  } else if (typeof input === 'string') {
    const raw = input.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
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
    return new Intl.DateTimeFormat('en-US', {
      timeZone: IST_TIMEZONE,
      weekday: 'short',
      month: 'short',
      day: '2-digit',
      year: 'numeric',
    }).format(date);
  }

  return `${weekday} ${month} ${day} ${year}`;
}

const buildWfhDates = (startDate: WfhDateInput, endDate: WfhDateInput): string => {
  const start = formatWfhDateIST(startDate);
  const end = formatWfhDateIST(endDate);
  return start === end ? start : `${start} to ${end}`;
};

async function wfhNotificationEventSucceeded(eventKey: string): Promise<boolean> {
  const row = await NotificationAutomationLog.query()
    .where('event_key', eventKey)
    .whereIn('status', ['SENT', 'READ', 'DISMISSED'])
    .where('success_count', '>', 0)
    .first();
  return Boolean(row);
}

async function clearRetriableWfhNotificationLogs(eventKey: string): Promise<void> {
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

/** Reuses leave notification toggles to avoid new org settings columns. */
export async function notifyWfhSubmitted(args: {
  orgId: string;
  wfhRequestId: string;
  applicantUserId: string;
  managerId: string | null;
  startDate: string;
  endDate: string;
}) {
  const settings = await getNotificationSettings(args.orgId);
  if (!settings.enabled_leave_submitted_notifications) return;

  const eventKey = `${args.orgId}:wfh_submitted:${args.wfhRequestId}`;
  if (await wfhNotificationEventSucceeded(eventKey)) return;

  const [applicant, hrUsers] = await Promise.all([
    User.query()
      .findById(args.applicantUserId)
      .select('id', 'first_name', 'last_name', 'department_id'),
    User.query()
      .where('org_id', args.orgId)
      .where('role', 'hr')
      .whereIn('status', ATTENDANCE_ACTIVE_EMPLOYEE_STATUSES as readonly string[])
      .whereNull('deleted_at')
      .select('id'),
  ]);

  if (!applicant) return;

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

  await clearRetriableWfhNotificationLogs(eventKey);

  const pending = await createPendingEventLog({
    orgId: args.orgId,
    subjectUserId: args.applicantUserId,
    ruleKey: 'wfh_submitted',
    eventKey,
    meta: {
      wfh_request_id: args.wfhRequestId,
      recipients: recipientIds,
    },
  });

  const result = await dispatchNotificationEvent({
    event: 'automation.wfh_submitted',
    scope: 'user',
    orgId: args.orgId,
    userIds: recipientIds,
    title: 'New WFH request submitted 📝',
    body: `${applicantName} has requested work from home for ${buildWfhDates(args.startDate, args.endDate)}. Please review and take action.`,
    data: {
      wfhRequestId: args.wfhRequestId,
      wfhDates: buildWfhDates(args.startDate, args.endDate),
      wfhApplicantName: applicantName,
    },
  });

  await markEventSent({
    logId: pending.id,
    audienceCount: recipientIds.length,
    successCount: result.successCount,
    failureCount: result.failureCount,
  });
}

export async function notifyWfhStatusChanged(args: {
  orgId: string;
  wfhRequestId: string;
  employeeUserId: string;
  startDate: string;
  endDate: string;
  status: 'APPROVED' | 'REJECTED';
}) {
  const settings = await getNotificationSettings(args.orgId);
  if (!settings.enabled_leave_status_notifications) {
    return;
  }

  const eventKey = `${args.orgId}:wfh_status:${args.wfhRequestId}:${args.status}`;
  if (await wfhNotificationEventSucceeded(eventKey)) {
    return;
  }

  const employeeUserId = String(args.employeeUserId ?? '').trim();
  if (!employeeUserId) {
    logger.warn(
      { orgId: args.orgId, wfhRequestId: args.wfhRequestId },
      'notifyWfhStatusChanged: missing employeeUserId',
    );
    return;
  }

  const employee = await User.query()
    .findById(employeeUserId)
    .select('id', 'first_name', 'last_name', 'status');
  if (!employee) {
    return;
  }
  if ((employee as any).status === 'INACTIVE') {
    return;
  }

  const employeeName =
    `${(employee as any).first_name ?? ''} ${(employee as any).last_name ?? ''}`.trim();

  await clearRetriableWfhNotificationLogs(eventKey);

  const pending = await createPendingEventLog({
    orgId: args.orgId,
    subjectUserId: employeeUserId,
    ruleKey: 'wfh_status_changed',
    eventKey,
    meta: {
      wfh_request_id: args.wfhRequestId,
      status: args.status,
    },
  });

  const approved = args.status === 'APPROVED';
  const result = await dispatchNotificationEvent({
    event: approved ? 'automation.wfh_approved' : 'automation.wfh_rejected',
    scope: 'user',
    orgId: args.orgId,
    userIds: [employeeUserId],
    title: approved ? 'Your WFH request was approved ✅' : 'Your WFH request was declined ❌',
    body: approved
      ? `Hi ${employeeName}, your work from home request for ${buildWfhDates(args.startDate, args.endDate)} has been approved.`
      : `Hi ${employeeName}, your work from home request for ${buildWfhDates(args.startDate, args.endDate)} was not approved. Please contact your manager or HR.`,
    data: {
      wfhRequestId: args.wfhRequestId,
      wfhDates: buildWfhDates(args.startDate, args.endDate),
      employeeName,
      status: args.status,
    },
  });

  await markEventSent({
    logId: pending.id,
    audienceCount: 1,
    successCount: result.successCount,
    failureCount: result.failureCount,
  });
}

export async function notifyWfhCancelled(args: {
  orgId: string;
  wfhRequestId: string;
  employeeUserId: string;
  startDate: string;
  endDate: string;
}) {
  const settings = await getNotificationSettings(args.orgId);
  if (!settings.enabled_leave_status_notifications) {
    return;
  }

  const eventKey = `${args.orgId}:wfh_cancelled:${args.wfhRequestId}`;
  if (await wfhNotificationEventSucceeded(eventKey)) {
    return;
  }

  const employee = await User.query()
    .findById(args.employeeUserId)
    .select('id', 'first_name', 'last_name', 'status');
  if (!employee || (employee as any).status === 'INACTIVE') {
    return;
  }

  const employeeName =
    `${(employee as any).first_name ?? ''} ${(employee as any).last_name ?? ''}`.trim();

  await clearRetriableWfhNotificationLogs(eventKey);

  const pending = await createPendingEventLog({
    orgId: args.orgId,
    subjectUserId: args.employeeUserId,
    ruleKey: 'wfh_cancelled',
    eventKey,
    meta: { wfh_request_id: args.wfhRequestId },
  });

  const result = await dispatchNotificationEvent({
    event: 'automation.wfh_cancelled',
    scope: 'user',
    orgId: args.orgId,
    userIds: [args.employeeUserId],
    title: 'Your WFH request was cancelled',
    body: `Hi ${employeeName}, your work from home request for ${buildWfhDates(args.startDate, args.endDate)} was cancelled.`,
    data: {
      wfhRequestId: args.wfhRequestId,
      wfhDates: buildWfhDates(args.startDate, args.endDate),
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
