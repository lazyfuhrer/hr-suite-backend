import { z } from 'zod';
import { createOfficeLocationSchema } from './office-location.validator';
import { createWorkShiftSchema } from './work-shift.validator';
import { ORG_USER_ROLES } from '../../constants/user-roles';

const boolFromQuery = () =>
  z.preprocess((val) => {
    if (val === undefined || val === null) return undefined;
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') {
      const v = val.trim().toLowerCase();
      if (v === 'true' || v === '1' || v === 'yes') return true;
      if (v === 'false' || v === '0' || v === 'no') return false;
    }
    return val;
  }, z.boolean());

const dateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format. Use YYYY-MM-DD');

const withSortAliases = (value: unknown): unknown => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const query = value as Record<string, unknown>;
  return {
    ...query,
    sort_by:
      query.sort_by !== undefined
        ? query.sort_by
        : query.sortby !== undefined
          ? query.sortby
          : undefined,
    sort_dir:
      query.sort_dir !== undefined
        ? query.sort_dir
        : query.sortdir !== undefined
          ? query.sortdir
          : undefined,
  };
};

const weekdayEnum = z.enum([
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
]);

const workingDaysSchema = z
  .array(
    z
      .string()
      .transform((v) => v.trim().toUpperCase())
      .refine(
        (v) =>
          // Use runtime check against the enum options; accept case-insensitive input
          (weekdayEnum.options as readonly string[]).includes(v),
        {
          message: 'Invalid day of week',
        },
      ),
  )
  .nonempty()
  .optional();

export const createDepartmentSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  manager_id: z.string().uuid().nullable().optional(),
  manager_ids: z.array(z.string().uuid()).optional(),
  employee_ids: z.array(z.string().uuid()).optional(),
  // Backward compatible single IDs:
  location_id: z.string().uuid().nullable().optional(),
  default_shift_id: z.string().uuid().nullable().optional(),
  // New multi-assignment fields:
  location_ids: z.array(z.string().uuid()).optional(),
  work_shift_ids: z.array(z.string().uuid()).optional(),
  // Optional: inline creation of office location and default shift for this department.
  // When provided, new OfficeLocation and/or WorkShift rows are created in the same transaction
  // and wired into the department's location_id/default_shift_id.
  location: createOfficeLocationSchema.optional(),
  default_shift: createWorkShiftSchema.optional(),
  // Optional list of working days for this department (e.g. ["MONDAY","TUESDAY",...]).
  // Values are normalized to UPPERCASE and validated against the weekday enum.
  working_days: workingDaysSchema,
  location_tracking_enabled: z.boolean().optional(),
});

export const updateDepartmentSchema = z.object({
  name: z.string().min(1).optional(),
  location_id: z.string().uuid().nullable().optional(),
  default_shift_id: z.string().uuid().nullable().optional(),
  location_ids: z.array(z.string().uuid()).optional(),
  work_shift_ids: z.array(z.string().uuid()).optional(),
  manager_id: z.string().uuid().nullable().optional(),
  manager_ids: z.array(z.string().uuid()).optional(),
  employee_ids: z.array(z.string().uuid()).optional(),
  working_days: workingDaysSchema,
  location: createOfficeLocationSchema.optional(),
  default_shift: createWorkShiftSchema.optional(),
  location_tracking_enabled: z.boolean().optional(),
});

export const updateDepartmentManagerSchema = z
  .object({
    manager_id: z.string().uuid().nullable().optional(),
    manager_ids: z.array(z.string().uuid()).optional(),
  })
  .refine((data) => data.manager_id !== undefined || data.manager_ids !== undefined, {
    message: 'Provide manager_id or manager_ids',
    path: ['manager_ids'],
  });

export const assignDepartmentEmployeesSchema = z.object({
  employee_ids: z.array(z.string().uuid()).min(1, 'At least one employee_id is required'),
});

export const departmentStatisticsQuerySchema = z.object({
  month: z.coerce.number().int().min(1).max(12).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  role: z.enum(ORG_USER_ROLES).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ON_NOTICE', 'ALL']).optional().default('ACTIVE'),
  include_unassigned: boolFromQuery().optional().default(true),
  include_empty: boolFromQuery().optional().default(false),
});

// Helper to accept enums case-insensitively by uppercasing incoming strings
const upperEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(
    (value) => (typeof value === 'string' ? value.toUpperCase() : value),
    z.enum(values),
  );

// Department Employee Summary query schema (no query params needed, department ID is in path)
export const departmentEmployeeSummaryQuerySchema = z.object({});

// Department Employee List query schema (department ID is in path, not query)
export const departmentEmployeeListQuerySchema = z.preprocess(
  withSortAliases,
  z.object({
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(10),
    status: upperEnum(['ACTIVE', 'INACTIVE', 'ON_NOTICE', 'ALL']).optional().default('ALL'),
    employment_type: upperEnum([
      'FULL_TIME',
      'PART_TIME',
      'CONTRACT',
      'INTERNSHIP',
      'FREELANCE',
    ]).optional(),
    work_mode: upperEnum(['ONSITE', 'HYBRID', 'REMOTE']).optional(),
    search: z
      .string()
      .optional()
      .transform((e) => (e === '' ? undefined : e)),
    sort_by: upperEnum(['NAME', 'JOIN_DATE', 'STATUS', 'EMPLOYMENT_TYPE', 'WORK_MODE'])
      .optional()
      .default('NAME'),
    sort_dir: upperEnum(['ASC', 'DESC']).optional().default('ASC'),
  }),
);

// Department List (admin list) query schema
export const departmentListQuerySchema = z
  .preprocess(
    withSortAliases,
    z.object({
      page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
      limit: z.coerce.number().int().min(1).max(100).optional().default(10),
      search: z
        .string()
        .trim()
        .optional()
        .transform((e) => (e === '' ? undefined : e)),
      status: upperEnum(['ACTIVE', 'INACTIVE', 'ALL']).optional().default('ALL'),
      sort_by: upperEnum(['NAME', 'EMPLOYEE_COUNT', 'MANAGER', 'CREATED_ON', 'STATUS'])
        .optional()
        .default('NAME'),
      sort_dir: upperEnum(['ASC', 'DESC']).optional().default('ASC'),
      from_date: dateStringSchema.optional(),
      to_date: dateStringSchema.optional(),
    }),
  )
  .superRefine((data, ctx) => {
    const hasFrom = Boolean(data.from_date);
    const hasTo = Boolean(data.to_date);
    if (hasFrom !== hasTo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'from_date and to_date must be provided together',
        path: ['from_date'],
      });
      return;
    }
    if (data.from_date && data.to_date) {
      const from = new Date(data.from_date);
      const to = new Date(data.to_date);
      if (from > to) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'from_date must be before or equal to to_date',
          path: ['from_date'],
        });
      }
    }
  });

export const departmentDetailsQuerySchema = z.preprocess(
  withSortAliases,
  z.object({
    page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(10),
    status: upperEnum(['ACTIVE', 'INACTIVE', 'ON_NOTICE', 'ALL']).optional().default('ALL'),
    sort_by: upperEnum(['NAME', 'JOIN_DATE', 'STATUS']).optional().default('NAME'),
    sort_dir: upperEnum(['ASC', 'DESC']).optional().default('ASC'),
  }),
);

export const departmentDashboardQuerySchema = z.object({
  month: z.coerce.number().int().min(1).max(12).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  role: z.enum(['admin', 'hr', 'manager', 'employee']).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ON_NOTICE', 'ALL']).optional().default('ACTIVE'),
  include_unassigned: boolFromQuery().optional().default(true),
  include_empty: boolFromQuery().optional().default(false),
});
