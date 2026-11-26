import { OrgNotificationSettings } from '../../models/OrgNotificationSettings';

export type NotificationSettings = {
  enabled_before_shift_start: boolean;
  enabled_after_shift_start_no_checkin: boolean;
  enabled_before_shift_end: boolean;
  enabled_after_shift_end_no_checkout: boolean;
  enabled_before_break_start: boolean;
  enabled_before_break_end: boolean;
  enabled_break_exceeded: boolean;
  enabled_birthday_notifications: boolean;
  enabled_work_anniversary_notifications: boolean;
  enabled_holiday_notifications: boolean;
  enabled_leave_submitted_notifications: boolean;
  enabled_leave_status_notifications: boolean;
  enabled_reimbursement_submitted_notifications: boolean;
  enabled_reimbursement_status_notifications: boolean;
  enabled_reimbursement_paid_notifications: boolean;
  enabled_occasion_self_notifications: boolean;
  enabled_location_request_notifications: boolean;
  before_shift_start_mins: number;
  after_shift_start_no_checkin_mins: number;
  before_shift_end_mins: number;
  after_shift_end_no_checkout_mins: number;
  before_break_start_mins: number;
  before_break_end_mins: number;
  break_exceeded_mins: number;
  location_request_interval_hours: number;
};

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled_before_shift_start: true,
  enabled_after_shift_start_no_checkin: true,
  enabled_before_shift_end: true,
  enabled_after_shift_end_no_checkout: true,
  enabled_before_break_start: true,
  enabled_before_break_end: true,
  enabled_break_exceeded: true,
  enabled_birthday_notifications: true,
  enabled_work_anniversary_notifications: true,
  enabled_holiday_notifications: true,
  enabled_leave_submitted_notifications: true,
  enabled_leave_status_notifications: true,
  enabled_reimbursement_submitted_notifications: true,
  enabled_reimbursement_status_notifications: true,
  enabled_reimbursement_paid_notifications: true,
  enabled_occasion_self_notifications: true,
  enabled_location_request_notifications: true,
  before_shift_start_mins: 15,
  after_shift_start_no_checkin_mins: 30,
  before_shift_end_mins: 15,
  after_shift_end_no_checkout_mins: 30,
  before_break_start_mins: 5,
  before_break_end_mins: 5,
  break_exceeded_mins: 20,
  location_request_interval_hours: 4,
};

export async function getNotificationSettings(orgId: string): Promise<NotificationSettings> {
  const row = await OrgNotificationSettings.query().findOne({ org_id: orgId });
  if (!row) {
    return { ...DEFAULT_NOTIFICATION_SETTINGS };
  }

  return {
    enabled_before_shift_start: row.enabled_before_shift_start,
    enabled_after_shift_start_no_checkin: row.enabled_after_shift_start_no_checkin,
    enabled_before_shift_end: row.enabled_before_shift_end,
    enabled_after_shift_end_no_checkout: row.enabled_after_shift_end_no_checkout,
    enabled_before_break_start: row.enabled_before_break_start,
    enabled_before_break_end: row.enabled_before_break_end,
    enabled_break_exceeded: row.enabled_break_exceeded,
    enabled_birthday_notifications: row.enabled_birthday_notifications ?? true,
    enabled_work_anniversary_notifications: row.enabled_work_anniversary_notifications ?? true,
    enabled_holiday_notifications: row.enabled_holiday_notifications ?? true,
    enabled_leave_submitted_notifications: row.enabled_leave_submitted_notifications ?? true,
    enabled_leave_status_notifications: row.enabled_leave_status_notifications ?? true,
    enabled_reimbursement_submitted_notifications:
      row.enabled_reimbursement_submitted_notifications ?? true,
    enabled_reimbursement_status_notifications:
      row.enabled_reimbursement_status_notifications ?? true,
    enabled_reimbursement_paid_notifications:
      (row as any).enabled_reimbursement_paid_notifications ?? true,
    enabled_occasion_self_notifications: row.enabled_occasion_self_notifications ?? true,
    enabled_location_request_notifications: row.enabled_location_request_notifications ?? true,
    before_shift_start_mins: row.before_shift_start_mins,
    after_shift_start_no_checkin_mins: row.after_shift_start_no_checkin_mins,
    before_shift_end_mins: row.before_shift_end_mins,
    after_shift_end_no_checkout_mins: row.after_shift_end_no_checkout_mins,
    before_break_start_mins: row.before_break_start_mins,
    before_break_end_mins: row.before_break_end_mins,
    break_exceeded_mins: row.break_exceeded_mins,
    location_request_interval_hours: row.location_request_interval_hours ?? 4,
  };
}

export async function upsertNotificationSettings(
  orgId: string,
  patch: Partial<NotificationSettings>,
): Promise<NotificationSettings> {
  const current = await getNotificationSettings(orgId);
  const next = { ...current, ...patch };

  await OrgNotificationSettings.query()
    .insert({
      org_id: orgId,
      ...next,
    })
    .onConflict('org_id')
    .merge({
      ...next,
      updated_at: new Date(),
    });

  return next;
}
