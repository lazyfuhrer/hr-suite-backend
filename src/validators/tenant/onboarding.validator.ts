import { z } from 'zod';
import { normalizeIndianPhone10Digits } from '../../utils/phone.utils';

const genderEnum = z.enum(['MALE', 'FEMALE', 'OTHER']);
const maritalStatusEnum = z.enum(['SINGLE', 'MARRIED', 'DIVORCED']);
const addressTypeEnum = z.enum(['PRESENT', 'PERMANENT']);
const docCategoryEnum = z.enum(['IDENTITY', 'EDUCATION', 'EXPERIENCE', 'FINANCE', 'LEGAL']);
const devicePrefEnum = z.enum(['WINDOWS', 'MACBOOK', 'LINUX']);

const emptyStringToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

// Finance payloads often send empty strings / missing fields from UI forms.
// For onboarding finance, treat those as 0 so we can persist without failing validation.
const nonNegativeNumberFromStringOrZero = z.preprocess((val) => {
  if (val === undefined || val === null || val === '') return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const cleaned = val.trim().replace(/,/g, '');
    if (cleaned === '') return 0;
    const n = Number(cleaned);
    if (Number.isFinite(n)) return n;
  }
  return val;
}, z.number().nonnegative());

const optionalNonEmptyString = z
  .preprocess(emptyStringToUndefined, z.string().trim().min(1))
  .optional();

const optionalBooleanFromForm = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return value;
}, z.boolean().optional());

const optionalEmail = z.preprocess(emptyStringToUndefined, z.string().trim().email()).optional();

const indianPhone10 = z.preprocess(
  (val) => {
    const normalized = normalizeIndianPhone10Digits(val);
    return normalized ?? val;
  },
  z.string().regex(/^\d{10}$/, 'Phone number must be 10 digits'),
);

const optionalIndianPhone10 = z.preprocess(emptyStringToUndefined, indianPhone10).optional();

export const onboardingProfileSchema = z.object({
  // Date of birth and gender are now optional at onboarding start.
  // Empty strings are treated as "not provided" for both fields.
  dob: z.preprocess(emptyStringToUndefined, z.string().trim().min(1)).optional(),
  gender: z.preprocess(emptyStringToUndefined, genderEnum).optional(),
  marital_status: maritalStatusEnum.optional(),
  nationality: optionalNonEmptyString,
  personal_email: optionalEmail,
  personal_phone: optionalIndianPhone10,
  alt_phone: optionalIndianPhone10,
  emergency_contacts: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        relation: z.string().trim().min(1),
        phone: indianPhone10,
        email: z.string().trim().email().optional(),
        is_primary: z.boolean().optional(),
      }),
    )
    .optional()
    .default([]),
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
    .optional()
    .default([]),
});

// Start employee onboarding - requires profile data to be provided upfront.
// This creates User + UserProfile + EmergencyContacts + Addresses in a single transaction.
export const onboardingStartSchema = z.object({
  firstName: z.string().min(1),
  // last_name is NOT nullable in DB, but we allow empty string for people who don't have one
  lastName: z.string().optional().default(''),
  email: z.string().email(),
  phone: optionalIndianPhone10,
  // Optional employee type to distinguish between manager and employee roles.
  // Defaults to "employee" to preserve backward compatibility with existing clients.
  employeeType: z.enum(['manager', 'employee', 'hr']).optional().default('employee'),
  department_id: z
    .string()
    .uuid()
    .optional()
    .or(z.literal(''))
    .transform((val) => (val === '' ? undefined : val)),
  // Profile object can be omitted entirely. When missing, we treat it as an empty object
  // and let onboardingProfileSchema apply its own inner defaults.
  profile: z.preprocess(
    (val) => (val === undefined || val === null ? {} : val),
    onboardingProfileSchema,
  ),
});

// Admin/HR: update core user profile data during onboarding.
export const onboardingAdminProfileUpdateSchema = z.object({
  email: z.preprocess(emptyStringToUndefined, z.string().trim().email()).optional(),
  firstName: z.preprocess(emptyStringToUndefined, z.string().trim().min(1)).optional(),
  lastName: z.string().optional(),
  employeeType: z.enum(['manager', 'employee', 'hr']).optional(),
  department_id: z
    .string()
    .uuid()
    .optional()
    .or(z.literal(''))
    .transform((val) => (val === '' ? undefined : val)),
  phone: optionalIndianPhone10,
});

// Reverse onboarding: minimal admin invite payload for creating an invited user
// who will later self-complete their onboarding flow.
export const reverseOnboardingInviteSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().optional().default(''),
  email: z.string().email(),
  department_id: z
    .string()
    .uuid()
    .optional()
    .or(z.literal(''))
    .transform((val) => (val === '' ? undefined : val)),
  designation: z
    .string()
    .trim()
    .optional()
    .or(z.literal(''))
    .transform((val) => (val === '' ? undefined : val)),
  role: z.enum(['admin', 'hr', 'manager', 'employee']).optional().default('employee'),
});

export const reverseOnboardingDraftListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  status: z.enum(['IN_PROGRESS', 'INVITED', 'REJECTED', 'ALL']).default('ALL'),
  search: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
  sort_dir: z.enum(['ASC', 'DESC']).default('DESC'),
});

export const onboardingInProgressUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  search: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
  sort_dir: z.enum(['ASC', 'DESC']).default('DESC'),
});

/**
 * Finance schema for onboarding.
 * All values are ANNUAL (yearly) except salary_per_month which is monthly.
 * The system automatically converts annual values to monthly by dividing by 12
 * when creating salary structures and payroll records.
 */
export const onboardingFinanceSchema = z
  .object({
    payroll_info: z
      .object({
        annual_ctc: nonNegativeNumberFromStringOrZero, // Annual CTC (defaults to 0)
      })
      .passthrough(),
    earnings: z
      .object({
        basic_salary: nonNegativeNumberFromStringOrZero, // Annual basic salary (defaults to 0)
        hra: nonNegativeNumberFromStringOrZero, // Annual HRA (defaults to 0)
        other_allowance: nonNegativeNumberFromStringOrZero, // Annual other allowance (defaults to 0)
        gross_earnings: nonNegativeNumberFromStringOrZero, // Annual gross earnings (defaults to 0)
      })
      .passthrough(),
    earnings_items: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(100),
            amount: nonNegativeNumberFromStringOrZero,
          })
          .passthrough(),
      )
      .optional(),
    deductions: z
      .object({
        pf: nonNegativeNumberFromStringOrZero, // Annual PF contribution
        professional_tax: nonNegativeNumberFromStringOrZero, // Annual professional tax
        total_deductions: nonNegativeNumberFromStringOrZero, // Annual total deductions (defaults to 0)
      })
      .passthrough(),
    deductions_items: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(100),
            amount: nonNegativeNumberFromStringOrZero,
          })
          .passthrough(),
      )
      .optional(),
    employer_contributions: z
      .object({
        pf: nonNegativeNumberFromStringOrZero, // Annual employer PF contribution
        total_contributions: nonNegativeNumberFromStringOrZero, // Annual total employer contributions
      })
      .passthrough()
      .optional(),
    net_payable: z
      .object({
        salary_per_month: nonNegativeNumberFromStringOrZero, // Monthly net salary (defaults to 0)
      })
      .passthrough(),
  })
  .passthrough()
  .refine(
    (data) => {
      const list = Array.isArray(data.earnings_items) ? data.earnings_items : [];
      const names = list
        .map((i) =>
          String(i.name || '')
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean);
      return new Set(names).size === names.length;
    },
    {
      message: 'earnings_items contains duplicate names',
      path: ['earnings_items'],
    },
  )
  .refine(
    (data) => {
      const list = Array.isArray(data.deductions_items) ? data.deductions_items : [];
      const names = list
        .map((i) =>
          String(i.name || '')
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean);
      return new Set(names).size === names.length;
    },
    {
      message: 'deductions_items contains duplicate names',
      path: ['deductions_items'],
    },
  );

export const onboardingDocumentSchema = z.object({
  doc_category: docCategoryEnum,
  doc_type: z.string().min(1),
  file_url: z.string().url(),
  file_key: z.string().min(1).optional(),
});

export const onboardingDocumentsSchema = z.object({
  documents: z
    .array(
      z.object({
        doc_category: docCategoryEnum,
        doc_type: z.string().min(1),
        file_url: z.string().url(),
        file_key: z.string().min(1).optional(),
      }),
    )
    .min(1),
});

export const onboardingDocumentsSummaryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  search: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
});

export const onboardingComplianceSchema = z.object({
  // These were previously required, but are now optional in the API payload.
  device_pref: devicePrefEnum.optional(),
  asset_agreement: z.boolean().optional(),
  policy_acknowledged: z.boolean().optional(),
  // Keep top-level offer_letter_url for backward compatibility, but allow it to be omitted
  // in favor of the nested documents.offer_letter_url.
  offer_letter_url: z.string().url().optional(),
  documents: z
    .object({
      offer_letter_url: z.string().url().optional(),
      cv_url: z.string().url().optional(),
      id_url: z.string().url().optional(),
      contract_agreement_url: z.string().url().optional(),
    })
    .optional(),
  // General documents array - allows uploading any document type with category and type
  // This enables 2-API-call flow: upload files → send URLs to compliance
  document_list: z
    .array(
      z.object({
        doc_category: docCategoryEnum,
        doc_type: z.string().min(1),
        file_url: z.string().url(),
        file_key: z.string().min(1).optional(),
      }),
    )
    .optional(),
});

export const onboardingEmploymentSchema = z.object({
  employeeId: optionalNonEmptyString,
  department_id: z
    .string()
    .uuid()
    .optional()
    .or(z.literal(''))
    .transform((val) => (val === '' ? undefined : val)),
  designation: z.string().min(1).optional(),
  date_of_joining: z.string().min(1).optional(), // ISO date (YYYY-MM-DD)
  employment_type: z
    .preprocess(
      (value) => (typeof value === 'string' ? value.toUpperCase() : value),
      z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'INTERNSHIP', 'FREELANCE']),
    )
    .optional(),
  work_mode: z
    .preprocess(
      (value) => (typeof value === 'string' ? value.toUpperCase() : value),
      z.enum(['ONSITE', 'HYBRID', 'REMOTE']),
    )
    .optional(),
  shift_mode: z.enum(['day', 'night']).optional(),
});

export const onboardingBankAndAssetUpdateSchema = z.object({
  ifsc_code: optionalNonEmptyString,
  bank_name: optionalNonEmptyString,
  account_number: optionalNonEmptyString,
  account_holder_name: optionalNonEmptyString,
  asset_device_pref: z.preprocess(
    (value) => (typeof value === 'string' ? value.toUpperCase() : value),
    devicePrefEnum.optional(),
  ),
  asset_agreement_accepted: optionalBooleanFromForm,
  device_serial_number: optionalNonEmptyString,
  pf_number: z.preprocess(emptyStringToUndefined, z.string().min(1).max(50).optional().nullable()),
  uan_number: z.preprocess(
    emptyStringToUndefined,
    z
      .string()
      .min(12)
      .max(12)
      .regex(/^[0-9]{12}$/)
      .optional()
      .nullable(),
  ),
});

export type OnboardingBankAndAssetUpdateInput = z.infer<typeof onboardingBankAndAssetUpdateSchema>;

export function hasOnboardingBankAndAssetUpdateFields(
  data: OnboardingBankAndAssetUpdateInput,
): boolean {
  return (
    data.ifsc_code !== undefined ||
    data.bank_name !== undefined ||
    data.account_number !== undefined ||
    data.account_holder_name !== undefined ||
    data.asset_device_pref !== undefined ||
    data.asset_agreement_accepted !== undefined ||
    data.device_serial_number !== undefined ||
    data.pf_number !== undefined ||
    data.uan_number !== undefined
  );
}

export const onboardingBenefitsSchema = z.object({
  // Simple booleans mapped onto normalized benefit_type enums.
  allowances: z
    .object({
      transportation: z.boolean().optional(),
      meal: z.boolean().optional(),
      internet: z.boolean().optional(),
    })
    .optional(),
  benefits: z
    .object({
      health_insurance: z.boolean().optional(),
      life_insurance: z.boolean().optional(),
      company_device: z.boolean().optional(),
      training_program: z.boolean().optional(),
      tuition: z.boolean().optional(),
      fitness_membership: z.boolean().optional(),
      mental_health_support: z.boolean().optional(),
    })
    .optional(),
  active_employee: z.boolean().optional(),
  send_welcome_email: z.boolean().optional(),
});
