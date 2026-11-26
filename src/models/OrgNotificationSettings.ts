import { BaseModel } from './BaseModel';

export class OrgNotificationSettings extends BaseModel {
  static tableName = 'org_notification_settings';

  org_id!: string;

  enabled_before_shift_start!: boolean;
  enabled_after_shift_start_no_checkin!: boolean;
  enabled_before_shift_end!: boolean;
  enabled_after_shift_end_no_checkout!: boolean;
  enabled_before_break_start!: boolean;
  enabled_before_break_end!: boolean;
  enabled_break_exceeded!: boolean;
  enabled_birthday_notifications!: boolean;
  enabled_work_anniversary_notifications!: boolean;
  enabled_holiday_notifications!: boolean;
  enabled_leave_submitted_notifications!: boolean;
  enabled_leave_status_notifications!: boolean;
  enabled_reimbursement_submitted_notifications!: boolean;
  enabled_reimbursement_status_notifications!: boolean;
  enabled_reimbursement_paid_notifications!: boolean;
  enabled_occasion_self_notifications!: boolean;
  enabled_location_request_notifications!: boolean;

  before_shift_start_mins!: number;
  after_shift_start_no_checkin_mins!: number;
  before_shift_end_mins!: number;
  after_shift_end_no_checkout_mins!: number;
  before_break_start_mins!: number;
  before_break_end_mins!: number;
  break_exceeded_mins!: number;
  location_request_interval_hours!: number;
}
