import { z } from 'zod';

import { normalizeIndianPhone10Digits } from '../../utils/phone.utils';
import { onboardingFinanceSchema } from './onboarding.validator';

export const BULK_IMPORT_MAX_ROWS = 200;
export const BULK_IMPORT_MAX_BYTES = 5 * 1024 * 1024;

export const BULK_IMPORT_CANONICAL_HEADERS = [
  'employee_id',
  'first_name',
  'last_name',
  'role',
  'official_email',
  'phone_number',
  'alt_phone',
  'gender',
  'dob',
  'personal_email',
  'blood_group',
  'marital_status',
  'nationality',
  'emergency_contact_name',
  'emergency_contact_phone',
  'emergency_contact_relation',
  'department_name',
  'department_id',
  'designation',
  'date_of_joining',
  'employment_type',
  'work_mode',
  'shift_mode',
  'send_welcome_email',
  'annual_ctc',
  'basic_salary',
  'hra',
  'other_allowance',
  'gross_earnings',
  'employer_pf',
  'employer_total_contributions',
  'employee_pf',
  'professional_tax',
  'total_deductions',
  'salary_per_month',
] as const;

const emptyStringToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalBooleanFromForm = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return value;
}, z.boolean());

const optionalNonNegativeNumber = z.preprocess((val) => {
  if (val === undefined || val === null || val === '') return undefined;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const cleaned = val.trim().replace(/,/g, '');
    if (cleaned === '') return undefined;
    const n = Number(cleaned);
    if (Number.isFinite(n)) return n;
  }
  return val;
}, z.number().nonnegative().optional());

const optionalIndianPhone = z.preprocess(
  (val) => {
    const normalized = normalizeIndianPhone10Digits(val);
    if (normalized) return normalized;
    if (val === undefined || val === null || val === '') return undefined;
    return val;
  },
  z
    .string()
    .regex(/^\d{10}$/, 'Phone number must be 10 digits')
    .optional(),
);

const optionalEmail = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return undefined;
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}, z.string().email().optional());

const optionalNonEmptyString = z.preprocess(
  emptyStringToUndefined,
  z.string().trim().min(1).optional(),
);

export const bulkImportUserRowSchema = z
  .object({
    rowNumber: z.number().int().positive(),
    employee_id: z.string().trim().min(1),
    first_name: z.string().trim().min(1),
    last_name: z.string().trim().min(1),
    role: z.preprocess(
      (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
      z.enum(['admin', 'hr', 'manager', 'employee']),
    ),
    official_email: z.preprocess(
      (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
      z.string().email(),
    ),
    phone_number: optionalIndianPhone,
    alt_phone: optionalIndianPhone,
    gender: z.preprocess(
      (value) => {
        if (value === undefined || value === null || value === '') return undefined;
        return typeof value === 'string' ? value.trim().toUpperCase() : value;
      },
      z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
    ),
    dob: z.preprocess(
      emptyStringToUndefined,
      z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
        .optional(),
    ),
    personal_email: optionalEmail,
    blood_group: optionalNonEmptyString,
    marital_status: z.preprocess(
      (value) => {
        if (value === undefined || value === null || value === '') return undefined;
        return typeof value === 'string' ? value.trim().toUpperCase() : value;
      },
      z.enum(['SINGLE', 'MARRIED', 'DIVORCED']).optional(),
    ),
    nationality: optionalNonEmptyString,
    emergency_contact_name: optionalNonEmptyString,
    emergency_contact_phone: optionalIndianPhone,
    emergency_contact_relation: optionalNonEmptyString,
    department_name: optionalNonEmptyString,
    department_id: z.preprocess(emptyStringToUndefined, z.string().uuid().optional()),
    designation: z.preprocess(emptyStringToUndefined, z.string().trim().min(1).optional()),
    date_of_joining: z.preprocess(
      emptyStringToUndefined,
      z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
        .optional(),
    ),
    employment_type: z.preprocess(
      (value) => {
        if (value === undefined || value === null || value === '') return undefined;
        return typeof value === 'string' ? value.trim().toUpperCase() : value;
      },
      z
        .enum(['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'INTERNSHIP', 'FREELANCE'])
        .optional(),
    ),
    work_mode: z.preprocess(
      (value) => {
        if (value === undefined || value === null || value === '') return undefined;
        return typeof value === 'string' ? value.trim().toUpperCase() : value;
      },
      z.enum(['ONSITE', 'HYBRID', 'REMOTE']).optional(),
    ),
    shift_mode: z.preprocess(
      (value) => {
        if (value === undefined || value === null || value === '') return undefined;
        return typeof value === 'string' ? value.trim().toLowerCase() : value;
      },
      z.enum(['day', 'night']).optional(),
    ),
    send_welcome_email: optionalBooleanFromForm,
    annual_ctc: optionalNonNegativeNumber,
    basic_salary: optionalNonNegativeNumber,
    hra: optionalNonNegativeNumber,
    other_allowance: optionalNonNegativeNumber,
    gross_earnings: optionalNonNegativeNumber,
    employer_pf: optionalNonNegativeNumber,
    employer_total_contributions: optionalNonNegativeNumber,
    employee_pf: optionalNonNegativeNumber,
    professional_tax: optionalNonNegativeNumber,
    total_deductions: optionalNonNegativeNumber,
    salary_per_month: optionalNonNegativeNumber,
  })
  .superRefine((row, ctx) => {
    const hasEmergencyName = row.emergency_contact_name !== undefined;
    const hasEmergencyPhone = row.emergency_contact_phone !== undefined;
    const hasEmergencyRelation = row.emergency_contact_relation !== undefined;
    const anyEmergency = hasEmergencyName || hasEmergencyPhone || hasEmergencyRelation;

    if (anyEmergency && !(hasEmergencyName && hasEmergencyPhone && hasEmergencyRelation)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'emergency_contact_name, emergency_contact_phone, and emergency_contact_relation are all required when any emergency contact field is provided',
        path: ['emergency_contact_name'],
      });
    }

    const hasPayroll =
      row.annual_ctc !== undefined ||
      row.basic_salary !== undefined ||
      row.hra !== undefined ||
      row.other_allowance !== undefined ||
      row.gross_earnings !== undefined ||
      row.employer_pf !== undefined ||
      row.employer_total_contributions !== undefined ||
      row.employee_pf !== undefined ||
      row.professional_tax !== undefined ||
      row.total_deductions !== undefined ||
      row.salary_per_month !== undefined;

    if (!hasPayroll) {
      return;
    }

    if (row.annual_ctc === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'annual_ctc is required when any payroll field is provided',
        path: ['annual_ctc'],
      });
      return;
    }

    const financePayload = {
      payroll_info: { annual_ctc: row.annual_ctc },
      earnings: {
        basic_salary: row.basic_salary ?? 0,
        hra: row.hra ?? 0,
        other_allowance: row.other_allowance ?? 0,
        gross_earnings: row.gross_earnings ?? 0,
      },
      earnings_items: [],
      employer_contributions: {
        pf: row.employer_pf ?? 0,
        total_contributions: row.employer_total_contributions ?? row.employer_pf ?? 0,
      },
      deductions: {
        pf: row.employee_pf ?? 0,
        professional_tax: row.professional_tax ?? 0,
        total_deductions: row.total_deductions ?? 0,
      },
      deductions_items: [],
      net_payable: {
        salary_per_month: row.salary_per_month ?? 0,
      },
    };

    const financeResult = onboardingFinanceSchema.safeParse(financePayload);
    if (!financeResult.success) {
      for (const issue of financeResult.error.issues) {
        ctx.addIssue({
          ...issue,
          path: ['payroll', ...issue.path],
        });
      }
    }
  });

export type BulkImportUserRow = z.infer<typeof bulkImportUserRowSchema>;

export const bulkImportQuerySchema = z.object({
  dry_run: z
    .preprocess((val) => val === 'true' || val === true, z.boolean())
    .optional()
    .default(false),
});

/** Map spreadsheet header aliases to canonical column names. */
export const BULK_IMPORT_HEADER_ALIASES: Record<
  string,
  (typeof BULK_IMPORT_CANONICAL_HEADERS)[number]
> = {
  employee_id: 'employee_id',
  employeeid: 'employee_id',
  'employee id': 'employee_id',
  emp_id: 'employee_id',
  first_name: 'first_name',
  firstname: 'first_name',
  'first name': 'first_name',
  last_name: 'last_name',
  lastname: 'last_name',
  'last name': 'last_name',
  role: 'role',
  official_email: 'official_email',
  email: 'official_email',
  'official email': 'official_email',
  phone_number: 'phone_number',
  phone: 'phone_number',
  'phone number': 'phone_number',
  alt_phone: 'alt_phone',
  'alt phone': 'alt_phone',
  alternate_phone: 'alt_phone',
  'alternate phone': 'alt_phone',
  alternate_phone_number: 'alt_phone',
  'alternate phone number': 'alt_phone',
  gender: 'gender',
  dob: 'dob',
  'date of birth': 'dob',
  date_of_birth: 'dob',
  personal_email: 'personal_email',
  'personal email': 'personal_email',
  blood_group: 'blood_group',
  'blood group': 'blood_group',
  marital_status: 'marital_status',
  'marital status': 'marital_status',
  nationality: 'nationality',
  emergency_contact_name: 'emergency_contact_name',
  'emergency contact name': 'emergency_contact_name',
  emergency_contact_phone: 'emergency_contact_phone',
  'emergency contact phone': 'emergency_contact_phone',
  emergency_contact_relation: 'emergency_contact_relation',
  'emergency contact relation': 'emergency_contact_relation',
  department_name: 'department_name',
  department: 'department_name',
  'department name': 'department_name',
  dept: 'department_name',
  'dept name': 'department_name',
  department_id: 'department_id',
  departmentid: 'department_id',
  'department id': 'department_id',
  designation: 'designation',
  date_of_joining: 'date_of_joining',
  join_date: 'date_of_joining',
  'join date': 'date_of_joining',
  doj: 'date_of_joining',
  employment_type: 'employment_type',
  'employment type': 'employment_type',
  work_mode: 'work_mode',
  'work mode': 'work_mode',
  shift_mode: 'shift_mode',
  'shift mode': 'shift_mode',
  send_welcome_email: 'send_welcome_email',
  'send welcome email': 'send_welcome_email',
  annual_ctc: 'annual_ctc',
  'annual ctc': 'annual_ctc',
  basic_salary: 'basic_salary',
  'basic salary': 'basic_salary',
  hra: 'hra',
  other_allowance: 'other_allowance',
  'other allowance': 'other_allowance',
  gross_earnings: 'gross_earnings',
  'gross earnings': 'gross_earnings',
  employer_pf: 'employer_pf',
  'employer pf': 'employer_pf',
  employer_total_contributions: 'employer_total_contributions',
  'employer total contributions': 'employer_total_contributions',
  employee_pf: 'employee_pf',
  'employee pf': 'employee_pf',
  professional_tax: 'professional_tax',
  'professional tax': 'professional_tax',
  total_deductions: 'total_deductions',
  'total deductions': 'total_deductions',
  salary_per_month: 'salary_per_month',
  'salary per month': 'salary_per_month',
};

export function normalizeBulkImportHeader(
  header: unknown,
): (typeof BULK_IMPORT_CANONICAL_HEADERS)[number] | null {
  if (header === undefined || header === null) return null;
  const key = String(header).trim().toLowerCase();
  if (!key) return null;
  return BULK_IMPORT_HEADER_ALIASES[key] ?? null;
}

export function buildFinancePayloadFromBulkRow(row: BulkImportUserRow) {
  return {
    payroll_info: { annual_ctc: row.annual_ctc ?? 0 },
    earnings: {
      basic_salary: row.basic_salary ?? 0,
      hra: row.hra ?? 0,
      other_allowance: row.other_allowance ?? 0,
      gross_earnings: row.gross_earnings ?? 0,
    },
    earnings_items: [],
    employer_contributions: {
      pf: row.employer_pf ?? 0,
      total_contributions: row.employer_total_contributions ?? row.employer_pf ?? 0,
    },
    deductions: {
      pf: row.employee_pf ?? 0,
      professional_tax: row.professional_tax ?? 0,
      total_deductions: row.total_deductions ?? 0,
    },
    deductions_items: [],
    net_payable: {
      salary_per_month: row.salary_per_month ?? 0,
    },
  };
}

export function rowHasPayroll(row: BulkImportUserRow): boolean {
  return row.annual_ctc !== undefined;
}

export function rowHasProfileFields(row: BulkImportUserRow): boolean {
  return (
    row.phone_number !== undefined ||
    row.alt_phone !== undefined ||
    row.gender !== undefined ||
    row.dob !== undefined ||
    row.personal_email !== undefined ||
    row.blood_group !== undefined ||
    row.marital_status !== undefined ||
    row.nationality !== undefined
  );
}

export function rowHasEmergencyContact(row: BulkImportUserRow): boolean {
  return (
    row.emergency_contact_name !== undefined &&
    row.emergency_contact_phone !== undefined &&
    row.emergency_contact_relation !== undefined
  );
}
