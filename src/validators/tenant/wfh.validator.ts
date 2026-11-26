import { z } from 'zod';

const intFromQuery = (min: number, max: number) =>
  z.preprocess((val) => {
    if (val === undefined || val === null || val === '') return undefined;
    if (typeof val === 'number') return val;
    if (typeof val === 'string') {
      const n = Number(val);
      if (Number.isFinite(n)) return n;
    }
    return val;
  }, z.number().int().min(min).max(max));

const upperEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(
    (value) => (typeof value === 'string' ? value.toUpperCase() : value),
    z.enum(values),
  );

const isValidDateString = (value: string): boolean => {
  const parts = value.split('-').map((part) => Number(part));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    return false;
  }
  const [year, month, day] = parts;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
};

const dateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
  .refine(isValidDateString, 'Invalid calendar date');

/** Lexicographic compare is correct for YYYY-MM-DD calendar dates. */
const isDateRangeOrdered = (start: string, end: string): boolean => start <= end;

export const wfhApplySchema = z
  .object({
    start_date: dateStringSchema,
    end_date: dateStringSchema,
    reason: z.string().min(1),
    attachment_url: z.string().url().optional(),
  })
  .refine((data) => isDateRangeOrdered(data.start_date, data.end_date), {
    message: 'start_date must be before or equal to end_date',
  });

export const wfhMyListQuerySchema = z
  .object({
    page: intFromQuery(1, 10_000).optional().default(1),
    limit: intFromQuery(1, 100).optional().default(10),
    status: upperEnum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
    start_date: dateStringSchema.optional(),
    end_date: dateStringSchema.optional(),
  })
  .refine(
    (data) => {
      if (data.start_date && data.end_date) {
        return isDateRangeOrdered(data.start_date, data.end_date);
      }
      return true;
    },
    { message: 'start_date must be before or equal to end_date' },
  );

export const wfhOrgListQuerySchema = z
  .object({
    page: intFromQuery(1, 10_000).optional().default(1),
    limit: intFromQuery(1, 100).optional().default(10),
    status: upperEnum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
    employee_id: z.string().uuid().optional(),
    department_id: z.string().uuid().optional(),
    search: z.string().trim().min(1).max(100).optional(),
    start_date: dateStringSchema.optional(),
    end_date: dateStringSchema.optional(),
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
      if (data.start_date && data.end_date) {
        return isDateRangeOrdered(data.start_date, data.end_date);
      }
      if (data.from_date && data.to_date) {
        return isDateRangeOrdered(data.from_date, data.to_date);
      }
      return true;
    },
    { message: 'Invalid date range' },
  );

export const wfhApproveSchema = z.object({
  requestId: z.string().uuid(),
  action: upperEnum(['APPROVE', 'REJECT']),
  comment: z.string().min(1).optional(),
});

export const wfhStatusUpdateSchema = z.object({
  status: upperEnum(['APPROVED', 'REJECTED', 'CANCELLED']),
  comment: z.string().min(1).optional(),
});

export const updateWfhRequestSchema = z
  .object({
    start_date: dateStringSchema.optional(),
    end_date: dateStringSchema.optional(),
    reason: z.string().min(1).optional(),
    // Allow null to explicitly remove an attachment
    attachment_url: z.string().url().optional().nullable(),
  })
  .refine(
    (data) => {
      if (data.start_date && data.end_date) {
        return isDateRangeOrdered(data.start_date, data.end_date);
      }
      return true;
    },
    { message: 'start_date must be before or equal to end_date' },
  );
