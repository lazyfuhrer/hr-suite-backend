import { z } from 'zod';
import { ORG_USER_ROLES } from '../../constants/user-roles';
import { onboardingFinanceSchema } from './onboarding.validator';

// const intFromQuery = (min: number, max: number) =>
//   z.preprocess((val) => {
//     if (val === undefined || val === null || val === '') return undefined;
//     if (typeof val === 'number') return val;
//     if (typeof val === 'string') {
//       const n = Number(val);
//       if (Number.isFinite(n)) return n;
//     }
//     return val;
//   }, z.number().int().min(min).max(max));

export const createUserSchema = z.object({
  email: z.email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  role: z.enum(['admin', 'hr', 'manager', 'employee']),
  departmentId: z.string().uuid().optional().nullable(),
  employeeId: z.string().min(1),
});

// Device accounts are used for hardware / integration activities (e.g., in-office face clock devices).
// They are intentionally NOT part of ORG_USER_ROLES and should be created via an admin-only endpoint.
/** Admin/HR: send a new temporary password to a user’s official email (same org). */
export const sendTemporaryPasswordSchema = z.object({
  email: z.string().trim().min(1).email(),
});

export const createDeviceUserSchema = z.object({
  name: z.string().trim().min(1).max(255),
  // Optional; when omitted we generate a unique email-like identifier.
  email: z.string().trim().email().optional(),
  // Optional; when omitted we generate a unique org-scoped employee_id.
  employeeId: z.string().trim().min(1).max(64).optional(),
  // Optional; when omitted we generate and return a password.
  password: z.string().min(8).max(128).optional(),
});

export const userListQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).default(10),
  role: z.enum(ORG_USER_ROLES).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  department_id: z.string().optional(),
  department: z.string().optional(), // Alias for department_id
  // Update: Allow optional string and transform empty string to undefined
  search: z
    .string()
    .optional()
    .transform((e) => (e === '' ? undefined : e)),
  // Update: Add sortBy parameter
  sortBy: z.enum(['name', 'joinDate', 'department', 'status']).optional().default('name'),
  status: z.string().optional().default('ALL'),
  view: z.enum(['list', 'statistics', 'both']).optional().default('list'),
});

export const userExcelDownloadQuerySchema = userListQuerySchema.omit({
  page: true,
  limit: true,
  view: true,
});

export const upcomingBirthdaysQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional().default(30),
  limit: z.coerce.number().int().min(1).max(100).optional().default(10),
});

export const userUnassignedQuerySchema = z.object({
  role: z.enum(['admin', 'hr', 'manager', 'employee']).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ON_NOTICE', 'ALL']).optional().default('ACTIVE'),
});

const emptyStringToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalNonEmptyString = z
  .preprocess(emptyStringToUndefined, z.string().trim().min(1))
  .optional();

const optionalEmail = z.preprocess(emptyStringToUndefined, z.string().trim().email()).optional();

const addressTypeEnum = z.enum(['PRESENT', 'PERMANENT']);

export const updatePersonalInfoSchema = z.object({
  personal_info: z
    .object({
      gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
      marital_status: z.enum(['SINGLE', 'MARRIED', 'DIVORCED']).optional(),
      dob: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
        .optional(),
      nationality: optionalNonEmptyString,
      personal_email: optionalEmail,
      personal_phone: optionalNonEmptyString,
      alt_phone: optionalNonEmptyString,
    })
    .optional(),
  bank_details: z
    .object({
      account_holder_name: optionalNonEmptyString,
      account_number: optionalNonEmptyString,
      ifsc_code: optionalNonEmptyString,
      bank_name: optionalNonEmptyString,
      branch_name: optionalNonEmptyString,
      account_type: z.enum(['SAVINGS', 'CURRENT', 'SALARY']).optional(),
    })
    .optional(),
  addresses: z
    .array(
      z.object({
        type: addressTypeEnum,
        street_address: optionalNonEmptyString,
        city: optionalNonEmptyString,
        state: optionalNonEmptyString,
        zip_code: optionalNonEmptyString,
        country: optionalNonEmptyString,
      }),
    )
    .optional(),
  payroll: z
    .object({
      pf_number: z.string().min(1).max(50).optional().nullable(),
      uan_number: z
        .string()
        .min(12)
        .max(12)
        .regex(/^[0-9]{12}$/)
        .optional()
        .nullable(),
    })
    .optional(),
});

export const editEmployeePayrollFinanceSchema = z
  .object({
    apply_from: z.enum(['CURRENT_MONTH', 'NEXT_MONTH']),
    finance: onboardingFinanceSchema,
  })
  .passthrough();

const clearableString = z.union([z.string(), z.literal('')]).optional();

export const updateUserByAdminSchema = z
  .object({
    firstName: clearableString,
    lastName: clearableString,
    full_name: clearableString,
    employee_id: clearableString,
    employeeId: clearableString,
    official_email: z.union([z.string().trim().email(), z.literal('')]).optional(),
    personal_email: z.union([z.string().trim().email(), z.literal('')]).optional(),
    phone: clearableString,
    designation: clearableString,
    departmentId: z.string().uuid().nullable().optional(),
    join_date: clearableString,
    gender: z.union([z.enum(['MALE', 'FEMALE', 'OTHER']), z.literal('')]).optional(),
    date_of_birth: z
      .union([
        z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
        z.literal(''),
      ])
      .optional(),
    employment_type: clearableString,
    work_mode: clearableString,
    address: clearableString,
    blood_group: clearableString,
    marital_status: z.union([z.enum(['SINGLE', 'MARRIED', 'DIVORCED']), z.literal('')]).optional(),
    nationality: clearableString,
    permanent_address: z
      .object({
        street: clearableString,
        city: clearableString,
        state: clearableString,
        postal_code: clearableString,
        country: clearableString,
      })
      .optional(),
    emergency_contact_name: optionalNonEmptyString,
    emergency_contact_phone: optionalNonEmptyString,
    relation: optionalNonEmptyString,
    /** null clears override (inherit from department); true/false forces tracking on/off */
    location_tracking_enabled: z.boolean().nullable().optional(),
  })
  .strict();
