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

// Helper to accept enums case-insensitively by uppercasing incoming strings
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

const daySessionSchema = upperEnum(['FULL', 'FIRST_HALF', 'SECOND_HALF']);

export const leaveApplySchema = z
  .object({
    leave_type_id: z.string().uuid(),
    start_date: dateStringSchema,
    end_date: dateStringSchema,
    day_session: daySessionSchema.optional().default('FULL'),
    reason: z.string().min(1),
    attachment_url: z.string().url().optional(),
  })
  .refine(
    (data) => {
      const start = new Date(data.start_date);
      const end = new Date(data.end_date);
      return start <= end;
    },
    { message: 'start_date must be before or equal to end_date' },
  )
  .refine((data) => data.day_session === 'FULL' || data.start_date === data.end_date, {
    message: 'A half-day leave must start and end on the same date',
    path: ['day_session'],
  });

export const leaveMyListQuerySchema = z
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
        const start = new Date(data.start_date);
        const end = new Date(data.end_date);
        return start <= end;
      }
      return true;
    },
    { message: 'start_date must be before or equal to end_date' },
  );

export const leaveMySummaryQuerySchema = z.object({
  year: intFromQuery(2000, 2100).optional(),
});

export const employeeLeavesQuerySchema = z.object({
  month: intFromQuery(1, 12).optional(),
  year: intFromQuery(2000, 2100).optional(),
});

export const leaveOrgListQuerySchema = z
  .object({
    page: intFromQuery(1, 10_000).optional().default(1),
    limit: intFromQuery(1, 100).optional().default(10),
    status: upperEnum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
    leave_type_id: z.string().uuid().optional(),
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
        const start = new Date(data.start_date);
        const end = new Date(data.end_date);
        return start <= end;
      }
      if (data.from_date && data.to_date) {
        const from = new Date(data.from_date);
        const to = new Date(data.to_date);
        return from <= to;
      }
      return true;
    },
    { message: 'Invalid date range' },
  );

export const leaveApproveSchema = z.object({
  requestId: z.string().uuid(),
  action: upperEnum(['APPROVE', 'REJECT']),
  comment: z.string().min(1).optional(),
});

// REST-ier status update schema for PATCH /leaves/requests/:id/status
export const leaveStatusUpdateSchema = z.object({
  status: upperEnum(['APPROVED', 'REJECTED', 'CANCELLED']),
  comment: z.string().min(1).optional(),
});

export const leaveDashboardQuerySchema = z.object({
  // All filters are optional and ignored by the controller;
  // they are kept only for backward-compatible validation of shape/types.
  month: intFromQuery(1, 12).optional(),
  year: intFromQuery(2000, 2100).optional(),
  from_date: dateStringSchema.optional(),
  to_date: dateStringSchema.optional(),
  focus_date: dateStringSchema.optional(),
});

export const managerLeaveDashboardQuerySchema = z
  .object({
    from_date: dateStringSchema,
    to_date: dateStringSchema,
    page: intFromQuery(1, 10_000).optional().default(1),
    limit: intFromQuery(1, 100).optional().default(10),
    search: z.string().trim().min(1).max(100).optional(),
  })
  .superRefine((data, ctx) => {
    const from = new Date(data.from_date);
    const to = new Date(data.to_date);
    if (from > to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'from_date must be before or equal to to_date',
        path: ['from_date'],
      });
    }
  });

export const createLeaveTypeSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  annual_quota: z.number().int().min(0).max(365),
});

export const updateLeaveTypeSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  annual_quota: z.number().int().min(0).max(365).optional(),
});

export const updateLeaveRequestSchema = z
  .object({
    leave_type_id: z.string().uuid().optional(),
    start_date: dateStringSchema.optional(),
    end_date: dateStringSchema.optional(),
    day_session: daySessionSchema.optional(),
    reason: z.string().min(1).optional(),
    // Allow null to explicitly remove an attachment
    attachment_url: z.string().url().optional().nullable(),
  })
  .refine(
    (data) => {
      if (data.start_date && data.end_date) {
        const start = new Date(data.start_date);
        const end = new Date(data.end_date);
        return start <= end;
      }
      return true;
    },
    { message: 'start_date must be before or equal to end_date' },
  );
