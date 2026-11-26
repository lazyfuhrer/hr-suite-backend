import { z } from 'zod';
import { REIMBURSEMENT_TYPES } from '../../constants/reimbursement-type';

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

const amountSchema = z.coerce
  .number()
  .positive('Amount must be greater than zero')
  .max(9_999_999.99, 'Amount exceeds maximum allowed');

export const reimbursementTypeSchema = upperEnum(REIMBURSEMENT_TYPES);

export const reimbursementApplySchema = z.object({
  request_date: dateStringSchema,
  type: reimbursementTypeSchema,
  reason: z.string().min(1),
  amount: amountSchema,
  attachment_url: z.string().url().optional(),
});

export const reimbursementMyListQuerySchema = z
  .object({
    page: intFromQuery(1, 10_000).optional().default(1),
    limit: intFromQuery(1, 100).optional().default(10),
    status: upperEnum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
    type: reimbursementTypeSchema.optional(),
    start_date: dateStringSchema.optional(),
    end_date: dateStringSchema.optional(),
  })
  .refine(
    (data) => {
      if (data.start_date && data.end_date) {
        return new Date(data.start_date) <= new Date(data.end_date);
      }
      return true;
    },
    { message: 'start_date must be before or equal to end_date' },
  );

export const reimbursementOrgListQuerySchema = z
  .object({
    page: intFromQuery(1, 10_000).optional().default(1),
    limit: intFromQuery(1, 100).optional().default(10),
    status: upperEnum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
    type: reimbursementTypeSchema.optional(),
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
        return new Date(data.start_date) <= new Date(data.end_date);
      }
      if (data.from_date && data.to_date) {
        return new Date(data.from_date) <= new Date(data.to_date);
      }
      return true;
    },
    { message: 'Invalid date range' },
  );

export const reimbursementApproveSchema = z.object({
  requestId: z.string().uuid(),
  action: upperEnum(['APPROVE', 'REJECT']),
  comment: z.string().min(1).optional(),
});

export const reimbursementStatusUpdateSchema = z.object({
  status: upperEnum(['APPROVED', 'REJECTED', 'CANCELLED']),
  comment: z.string().min(1).optional(),
});

export const updateReimbursementRequestSchema = z.object({
  request_date: dateStringSchema.optional(),
  type: reimbursementTypeSchema.optional(),
  reason: z.string().min(1).optional(),
  amount: amountSchema.optional(),
  attachment_url: z.string().url().optional().nullable(),
});

export const markReimbursementMonthPaidSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});
