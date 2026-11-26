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

// Payroll status enum (defined early for use in multiple schemas)
const payrollStatusEnum = upperEnum([
  'PENDING',
  'ADJUSTED',
  'PAID',
  'DRAFT',
  'PROCESSED',
  'CANCELLED',
]);

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

// Employee validators
export const payrollMonthYearQuerySchema = z.object({
  month: intFromQuery(1, 12).optional(),
  year: intFromQuery(2000, 2100).optional(),
});

export const updateUserPayrollDetailSchema = z.object({
  pan_number: z
    .string()
    .min(10)
    .max(10)
    .regex(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/)
    .optional()
    .nullable(),
  aadhaar_number: z
    .string()
    .min(12)
    .max(12)
    .regex(/^[0-9]{12}$/)
    .optional()
    .nullable(),
  pf_number: z.string().min(1).max(50).optional().nullable(),
  uan_number: z
    .string()
    .min(12)
    .max(12)
    .regex(/^[0-9]{12}$/)
    .optional()
    .nullable(),
  esi_number: z.string().min(1).max(50).optional().nullable(),
  tax_saving_investments: z.string().optional().nullable(),
  declared_tax: z.number().nonnegative().optional().nullable(),
});

// Admin validators
export const createSalaryComponentSchema = z.object({
  name: z.string().min(1).max(100),
  code: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[A-Z0-9_]+$/),
  type: z.enum(['EARNING', 'DEDUCTION', 'ALLOWANCE', 'BONUS', 'OVERTIME', 'INCENTIVE']),
  is_taxable: z.boolean().default(true),
  is_pf_applicable: z.boolean().default(false),
  is_esi_applicable: z.boolean().default(false),
  display_order: z.number().int().nonnegative().default(0),
});

export const updateSalaryComponentSchema = createSalaryComponentSchema.partial();

// Base schema without refinements (for partial updates)
const baseSalaryStructureSchema = z.object({
  user_id: z.string().uuid(),
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effective_to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
  gross_salary: z.number().positive(),
  net_salary: z.number().positive(),
  component_breakdown: z.record(z.string().uuid(), z.number().nonnegative()),
  notes: z.string().optional().nullable(),
});

export const createSalaryStructureSchema = baseSalaryStructureSchema
  .refine(
    (data) => {
      if (data.effective_to) {
        const from = new Date(data.effective_from);
        const to = new Date(data.effective_to);
        return from <= to;
      }
      return true;
    },
    { message: 'effective_from must be before or equal to effective_to' },
  )
  .refine(
    (data) => {
      // Net salary should not exceed gross salary
      return data.net_salary <= data.gross_salary;
    },
    { message: 'net_salary cannot exceed gross_salary' },
  );

// For update, create partial schema and add conditional refinements
export const updateSalaryStructureSchema = baseSalaryStructureSchema
  .partial()
  .extend({
    user_id: z.string().uuid().optional(),
  })
  .refine(
    (data) => {
      if (data.effective_from && data.effective_to) {
        const from = new Date(data.effective_from);
        const to = new Date(data.effective_to);
        return from <= to;
      }
      return true;
    },
    { message: 'effective_from must be before or equal to effective_to' },
  )
  .refine(
    (data) => {
      if (data.gross_salary !== undefined && data.net_salary !== undefined) {
        return data.net_salary <= data.gross_salary;
      }
      return true;
    },
    { message: 'net_salary cannot exceed gross_salary' },
  );

export const payrollRecordsListQuerySchema = z
  .object({
    page: intFromQuery(1, 10_000).optional().default(1),
    limit: intFromQuery(1, 100).optional().default(10),
    month: intFromQuery(1, 12).optional(),
    year: intFromQuery(2000, 2100).optional(),
    from_date: dateStringSchema.optional(),
    to_date: dateStringSchema.optional(),
    user_id: z.string().uuid().optional(),
    status: payrollStatusEnum.optional(),
    search: z.string().trim().min(1).max(100).optional(),
  })
  .refine(
    (data) => {
      const hasMonth = data.month !== undefined;
      const hasYear = data.year !== undefined;
      return hasMonth === hasYear;
    },
    { message: 'month and year must be provided together', path: ['month'] },
  )
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
      const hasMonthYear = data.month !== undefined && data.year !== undefined;
      const hasFromTo = Boolean(data.from_date) || Boolean(data.to_date);
      if (hasMonthYear && hasFromTo) {
        return false;
      }
      return true;
    },
    {
      message: 'from_date and to_date cannot be used with month and year',
      path: ['from_date'],
    },
  )
  .refine(
    (data) => {
      if (data.from_date && data.to_date) {
        return new Date(data.from_date) <= new Date(data.to_date);
      }
      return true;
    },
    { message: 'from_date must be before or equal to to_date' },
  );

export const createPayrollRecordSchema = z.object({
  user_id: z.string().uuid(),
  payroll_month: intFromQuery(1, 12),
  payroll_year: intFromQuery(2000, 2100),
  gross_salary: z.number().nonnegative(),
  total_earnings: z.number().nonnegative(),
  total_deductions: z.number().nonnegative(),
  net_salary: z.number().nonnegative(),
  pf_contribution: z.number().nonnegative().optional().nullable(),
  professional_tax: z.number().nonnegative().optional().nullable(),
  overtime_amount: z.number().nonnegative().optional().default(0),
  incentive_amount: z.number().nonnegative().optional().default(0),
  bonus_amount: z.number().nonnegative().optional().default(0),
  allowance_amount: z.number().nonnegative().optional().default(0),
  component_breakdown: z.record(z.string(), z.number()).optional().default({}),
  notes: z.string().optional().nullable(),
});

// IMPORTANT: Update schema must NOT inherit defaults from create schema.
// Otherwise, omitted fields can be defaulted (e.g. incentive_amount -> 0) and wipe existing values.
export const updatePayrollRecordSchema = z.object({
  user_id: z.string().uuid().optional(),
  payroll_month: intFromQuery(1, 12).optional(),
  payroll_year: intFromQuery(2000, 2100).optional(),
  gross_salary: z.number().nonnegative().optional(),
  total_earnings: z.number().nonnegative().optional(),
  total_deductions: z.number().nonnegative().optional(),
  net_salary: z.number().nonnegative().optional(),
  pf_contribution: z.number().nonnegative().optional().nullable(),
  professional_tax: z.number().nonnegative().optional().nullable(),
  overtime_amount: z.number().nonnegative().optional(),
  incentive_amount: z.number().nonnegative().optional(),
  bonus_amount: z.number().nonnegative().optional(),
  allowance_amount: z.number().nonnegative().optional(),
  component_breakdown: z.record(z.string(), z.number()).optional(),
  notes: z.string().optional().nullable(),
  status: payrollStatusEnum.optional(),
});

export const payrollUploadQuerySchema = z.object({
  month: intFromQuery(1, 12),
  year: intFromQuery(2000, 2100),
});

export const payrollAdjustmentQuerySchema = z.object({
  month: intFromQuery(1, 12),
  year: intFromQuery(2000, 2100),
});

export const incentiveItemSchema = z.object({
  name: z.string().min(1),
  amount: z.number().nonnegative(),
});

export const deductionItemSchema = z.object({
  name: z.string().min(1),
  amount: z.number().nonnegative(),
});

export const payrollAdjustmentUpdateSchema = z.object({
  salary_per_month: z.number().nonnegative().optional(),
  fixed_salary: z.number().nonnegative().optional(),
  added_amount: z.number().nonnegative().optional(),
  incentives: z.array(incentiveItemSchema).optional(),
  extra_deductions: z.array(deductionItemSchema).optional(),
});

export const payrollDashboardSummaryQuerySchema = z.object({
  month: intFromQuery(1, 12).optional(),
  year: intFromQuery(2000, 2100).optional(),
});

export const payrollListQuerySchema = z
  .object({
    page: intFromQuery(1, 10_000).optional().default(1),
    limit: intFromQuery(1, 100).optional().default(10),
    month: intFromQuery(1, 12).optional(),
    year: intFromQuery(2000, 2100).optional(),
    start_date: dateStringSchema.optional(),
    end_date: dateStringSchema.optional(),
    from_date: dateStringSchema.optional(),
    to_date: dateStringSchema.optional(),
    user_id: z.string().uuid().optional(),
    status: payrollStatusEnum.optional(),
    search: z
      .string()
      .optional()
      .transform((e) => (e === '' ? undefined : e)),
    sort_by: upperEnum(['NAME', 'JOB_TITLE', 'SALARY', 'TOTAL', 'STATUS', 'DATE'])
      .optional()
      .default('DATE'),
    sort_dir: upperEnum(['ASC', 'DESC']).optional().default('DESC'),
  })
  .refine(
    (data) => {
      const hasMonth = data.month !== undefined;
      const hasYear = data.year !== undefined;
      return hasMonth === hasYear;
    },
    { message: 'month and year must be provided together', path: ['month'] },
  )
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
      const hasMonthYear = data.month !== undefined && data.year !== undefined;
      const hasFromTo = Boolean(data.from_date) || Boolean(data.to_date);
      if (hasMonthYear && hasFromTo) {
        return false;
      }
      return true;
    },
    {
      message: 'from_date and to_date cannot be used with month and year',
      path: ['from_date'],
    },
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

export const employeePayrollsQuerySchema = z.object({
  page: intFromQuery(1, 10_000).optional().default(1),
  limit: intFromQuery(1, 100).optional().default(10),
  month: intFromQuery(1, 12).optional(),
  year: intFromQuery(2000, 2100).optional(),
  status: payrollStatusEnum.optional(),
});

// Employee "My Pay" validators
export const myPayQuerySchema = z.object({
  month: intFromQuery(1, 12).optional(),
  year: intFromQuery(2000, 2100).optional(),
});

export const myPayHistoryQuerySchema = z.object({
  page: intFromQuery(1, 10_000).optional().default(1),
  limit: intFromQuery(1, 100).optional().default(10),
});
