import { z } from 'zod';

const activityTypeSchema = z.enum([
  'LEAVE_APPLIED',
  'LEAVE_APPROVED',
  'LEAVE_REJECTED',
  'LEAVE_CANCELLED',
  'WFH_APPLIED',
  'WFH_APPROVED',
  'WFH_REJECTED',
  'WFH_CANCELLED',
  'REIMBURSEMENT_CANCELLED',
  'ATTENDANCE_REQUEST_CREATED',
  'ATTENDANCE_REQUEST_APPROVED',
  'ATTENDANCE_REQUEST_REJECTED',
  'ATTENDANCE_REQUEST_CANCELLED',
  'CLOCKED_IN',
  'CLOCKED_OUT',
]);

const dateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format');

export const activityListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    activity_type: activityTypeSchema.optional(),
    actor_user_id: z.string().uuid().optional(),
    target_user_id: z.string().uuid().optional(),
    from_date: dateStringSchema.optional(),
    to_date: dateStringSchema.optional(),
  })
  .refine(
    (data) => {
      const hasFrom = Boolean(data.from_date);
      const hasTo = Boolean(data.to_date);
      return hasFrom === hasTo;
    },
    { message: 'from_date and to_date must be provided together' },
  )
  .refine(
    (data) => {
      if (data.from_date && data.to_date) {
        return new Date(data.from_date) <= new Date(data.to_date);
      }
      return true;
    },
    { message: 'Invalid date range' },
  );
