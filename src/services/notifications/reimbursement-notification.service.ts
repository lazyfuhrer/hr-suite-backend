import { User } from '../../models/User';
import { NotificationAutomationLog } from '../../models/NotificationAutomationLog';
import { DepartmentManager } from '../../models/DepartmentManager';
import { ATTENDANCE_ACTIVE_EMPLOYEE_STATUSES } from '../../constants/user-status';
import { logger } from '../../config/logger';
import { dispatchNotificationEvent } from './notification-dispatcher.service';
import { getNotificationSettings } from './notification-settings.service';

const IST_TIMEZONE = 'Asia/Kolkata';

function formatRequestDateIST(input: string | Date | null | undefined): string {
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

  return new Intl.DateTimeFormat('en-US', {
    timeZone: IST_TIMEZONE,
    weekday: 'short',
    month: 'short',
    day: '2-digit',
    year: 'numeric',
  }).format(date);
}

async function reimbursementNotificationEventSucceeded(eventKey: string): Promise<boolean> {
  const row = await NotificationAutomationLog.query()
    .where('event_key', eventKey)
    .whereIn('status', ['SENT', 'READ', 'DISMISSED'])
    .where('success_count', '>', 0)
    .first();
  return Boolean(row);
}

async function clearRetriableReimbursementNotificationLogs(eventKey: string): Promise<void> {
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

export async function notifyReimbursementSubmitted(args: {
  orgId: string;
  reimbursementRequestId: string;
  applicantUserId: string;
  managerId: string | null;
  requestDate: string;
  amount: number;
}) {
  const settings = await getNotificationSettings(args.orgId);
  if (!settings.enabled_reimbursement_submitted_notifications) return;

  const eventKey = `${args.orgId}:reimbursement_submitted:${args.reimbursementRequestId}`;
  if (await reimbursementNotificationEventSucceeded(eventKey)) return;

  const applicant = await User.query()
    .findById(args.applicantUserId)
    .select('id', 'first_name', 'last_name', 'department_id');

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

  const hrUsers = await User.query()
    .where('org_id', args.orgId)
    .where('role', 'hr')
    .whereIn('status', ATTENDANCE_ACTIVE_EMPLOYEE_STATUSES as readonly string[])
    .whereNull('deleted_at')
    .select('id');

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

  await clearRetriableReimbursementNotificationLogs(eventKey);

  const pending = await createPendingEventLog({
    orgId: args.orgId,
    subjectUserId: args.applicantUserId,
    ruleKey: 'reimbursement_submitted',
    eventKey,
    meta: {
      reimbursement_request_id: args.reimbursementRequestId,
      recipients: recipientIds,
    },
  });

  const formattedDate = formatRequestDateIST(args.requestDate);
  const amountLabel = `₹${args.amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const result = await dispatchNotificationEvent({
    event: 'automation.reimbursement_submitted',
    scope: 'user',
    orgId: args.orgId,
    userIds: recipientIds,
    title: 'New reimbursement request submitted',
    body: `${applicantName} submitted a reimbursement of ${amountLabel} for ${formattedDate}. Please review.`,
    data: {
      reimbursementRequestId: args.reimbursementRequestId,
      requestDate: formattedDate,
      amount: String(args.amount),
      applicantName,
    },
  });

  await markEventSent({
    logId: pending.id,
    audienceCount: recipientIds.length,
    successCount: result.successCount,
    failureCount: result.failureCount,
  });
}

export async function notifyReimbursementStatusChanged(args: {
  orgId: string;
  reimbursementRequestId: string;
  employeeUserId: string;
  requestDate: string;
  amount: number;
  status: 'APPROVED' | 'REJECTED';
}) {
  const settings = await getNotificationSettings(args.orgId);
  if (!settings.enabled_reimbursement_status_notifications) {
    return;
  }

  const eventKey = `${args.orgId}:reimbursement_status:${args.reimbursementRequestId}:${args.status}`;
  if (await reimbursementNotificationEventSucceeded(eventKey)) {
    return;
  }

  const employeeUserId = String(args.employeeUserId ?? '').trim();
  if (!employeeUserId) {
    logger.warn(
      { orgId: args.orgId, reimbursementRequestId: args.reimbursementRequestId },
      'notifyReimbursementStatusChanged: missing employeeUserId',
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

  await clearRetriableReimbursementNotificationLogs(eventKey);

  const pending = await createPendingEventLog({
    orgId: args.orgId,
    subjectUserId: employeeUserId,
    ruleKey: 'reimbursement_status',
    eventKey,
    meta: {
      reimbursement_request_id: args.reimbursementRequestId,
      status: args.status,
    },
  });

  const formattedDate = formatRequestDateIST(args.requestDate);
  const amountLabel = `₹${args.amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const isApproved = args.status === 'APPROVED';

  const result = await dispatchNotificationEvent({
    event: isApproved ? 'automation.reimbursement_approved' : 'automation.reimbursement_rejected',
    scope: 'user',
    orgId: args.orgId,
    userIds: [employeeUserId],
    title: isApproved ? 'Reimbursement approved' : 'Reimbursement rejected',
    body: isApproved
      ? `Your reimbursement request of ${amountLabel} for ${formattedDate} has been approved.`
      : `Your reimbursement request of ${amountLabel} for ${formattedDate} has been rejected.`,
    data: {
      reimbursementRequestId: args.reimbursementRequestId,
      requestDate: formattedDate,
      amount: String(args.amount),
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

export async function notifyReimbursementPaid(args: {
  orgId: string;
  reimbursementRequestId: string;
  employeeUserId: string;
  requestDate: string;
  amount: number;
  paidAt?: string | Date | null;
}) {
  const settings = await getNotificationSettings(args.orgId);
  if (!(settings as any).enabled_reimbursement_paid_notifications) {
    return;
  }

  const eventKey = `${args.orgId}:reimbursement_paid:${args.reimbursementRequestId}`;
  if (await reimbursementNotificationEventSucceeded(eventKey)) {
    return;
  }

  const employeeUserId = String(args.employeeUserId ?? '').trim();
  if (!employeeUserId) {
    logger.warn(
      { orgId: args.orgId, reimbursementRequestId: args.reimbursementRequestId },
      'notifyReimbursementPaid: missing employeeUserId',
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

  await clearRetriableReimbursementNotificationLogs(eventKey);

  const pending = await createPendingEventLog({
    orgId: args.orgId,
    subjectUserId: employeeUserId,
    ruleKey: 'reimbursement_paid',
    eventKey,
    meta: {
      reimbursement_request_id: args.reimbursementRequestId,
      status: 'PAID',
    },
  });

  const formattedDate = formatRequestDateIST(args.requestDate);
  const amountLabel = `₹${args.amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const result = await dispatchNotificationEvent({
    event: 'automation.reimbursement_paid',
    scope: 'user',
    orgId: args.orgId,
    userIds: [employeeUserId],
    title: 'Reimbursement paid',
    body: `Your reimbursement of ${amountLabel} for ${formattedDate} has been marked as paid.`,
    data: {
      reimbursementRequestId: args.reimbursementRequestId,
      requestDate: formattedDate,
      amount: String(args.amount),
      employeeName,
      status: 'PAID',
      paidAt: args.paidAt ? String(args.paidAt) : '',
    },
  });

  await markEventSent({
    logId: pending.id,
    audienceCount: 1,
    successCount: result.successCount,
    failureCount: result.failureCount,
  });
}
