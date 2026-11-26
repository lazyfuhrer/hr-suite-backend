import { z } from 'zod';

const minsSchema = z.coerce.number().int().nonnegative().max(1440);
const hoursSchema = z.coerce.number().int().min(1).max(24);

export const updateNotificationSettingsSchema = z.object({
  enabled_before_shift_start: z.boolean().optional(),
  enabled_after_shift_start_no_checkin: z.boolean().optional(),
  enabled_before_shift_end: z.boolean().optional(),
  enabled_after_shift_end_no_checkout: z.boolean().optional(),
  enabled_before_break_start: z.boolean().optional(),
  enabled_before_break_end: z.boolean().optional(),
  enabled_break_exceeded: z.boolean().optional(),
  enabled_birthday_notifications: z.boolean().optional(),
  enabled_work_anniversary_notifications: z.boolean().optional(),
  enabled_holiday_notifications: z.boolean().optional(),
  enabled_leave_submitted_notifications: z.boolean().optional(),
  enabled_leave_status_notifications: z.boolean().optional(),
  enabled_reimbursement_submitted_notifications: z.boolean().optional(),
  enabled_reimbursement_status_notifications: z.boolean().optional(),
  enabled_reimbursement_paid_notifications: z.boolean().optional(),
  enabled_occasion_self_notifications: z.boolean().optional(),
  enabled_location_request_notifications: z.boolean().optional(),

  before_shift_start_mins: minsSchema.optional(),
  after_shift_start_no_checkin_mins: minsSchema.optional(),
  before_shift_end_mins: minsSchema.optional(),
  after_shift_end_no_checkout_mins: minsSchema.optional(),
  before_break_start_mins: minsSchema.optional(),
  before_break_end_mins: minsSchema.optional(),
  break_exceeded_mins: minsSchema.optional(),
  location_request_interval_hours: hoursSchema.optional(),
});
