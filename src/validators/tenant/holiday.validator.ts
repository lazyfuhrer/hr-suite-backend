import { z } from 'zod';

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

export const createHolidaysSchema = z.object({
  items: z
    .array(
      z.object({
        from_date: z.string().regex(dateRegex, 'from_date must be in YYYY-MM-DD format'),
        to_date: z.string().regex(dateRegex, 'to_date must be in YYYY-MM-DD format'),
        title: z.string().trim().min(1, 'title is required').max(120, 'title is too long'),
      }),
    )
    .min(1, 'at least one holiday range is required')
    .max(100, 'too many holiday ranges in one request'),
});

export const deleteHolidayParamsSchema = z.object({
  id: z.string().uuid('invalid holiday id'),
});

export const userHolidayParamsSchema = z.object({
  userId: z.string().uuid('invalid user id'),
});

export const upsertUserHolidaysSchema = z.object({
  items: z
    .array(
      z.object({
        holiday_id: z.string().uuid('invalid holiday_id'),
        enabled: z.boolean(),
      }),
    )
    .min(1, 'at least one holiday override is required')
    .max(200, 'too many holiday overrides in one request'),
});
