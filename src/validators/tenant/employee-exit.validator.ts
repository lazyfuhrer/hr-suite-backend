import { z } from 'zod';

import { USER_EXIT_TYPES } from '../../constants/user-exit';

const exitTypeSchema = z.enum(USER_EXIT_TYPES);

const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected date in YYYY-MM-DD format');

export const initiateEmployeeExitSchema = z
  .object({
    exit_type: exitTypeSchema,
    exit_reason: z.string().trim().max(2000).optional().nullable(),
    notice_start_date: calendarDateSchema.optional().nullable(),
    last_working_day: calendarDateSchema,
  })
  .refine(
    (data) =>
      !data.notice_start_date ||
      !data.last_working_day ||
      data.notice_start_date <= data.last_working_day,
    {
      message: 'notice_start_date must be on or before last_working_day',
      path: ['notice_start_date'],
    },
  );

export const updateEmployeeExitSchema = z
  .object({
    exit_type: exitTypeSchema.optional(),
    exit_reason: z.string().trim().max(2000).optional().nullable(),
    notice_start_date: calendarDateSchema.optional().nullable(),
    last_working_day: calendarDateSchema.optional(),
  })
  .refine(
    (data) =>
      data.exit_type !== undefined ||
      data.exit_reason !== undefined ||
      data.notice_start_date !== undefined ||
      data.last_working_day !== undefined,
    { message: 'At least one field is required' },
  );

export const immediateEmployeeExitSchema = z.object({
  exit_type: exitTypeSchema,
  exit_reason: z.string().trim().max(2000).optional().nullable(),
  last_working_day: calendarDateSchema.optional(),
});
