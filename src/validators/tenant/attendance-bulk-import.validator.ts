import { z } from 'zod';

export const ATTENDANCE_BULK_IMPORT_MAX_ROWS = 5000;
export const ATTENDANCE_BULK_IMPORT_MAX_BYTES = 5 * 1024 * 1024;

export const ATTENDANCE_BULK_IMPORT_CANONICAL_HEADERS = [
  'official_email',
  'date',
  'status',
  'total_work_minutes',
  'overtime_minutes',
] as const;

const emptyStringToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const nonNegativeIntFromForm = z.preprocess((val) => {
  if (val === undefined || val === null || val === '') return undefined;
  if (typeof val === 'number' && Number.isFinite(val)) return Math.trunc(val);
  if (typeof val === 'string') {
    const cleaned = val.trim().replace(/,/g, '');
    if (cleaned === '') return undefined;
    const n = Number(cleaned);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return val;
}, z.number().int().nonnegative());

export const attendanceBulkImportRowSchema = z
  .object({
    rowNumber: z.number().int().positive(),
    official_email: z.preprocess(
      (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
      z.string().email(),
    ),
    date: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
    status: z.preprocess(
      (value) => (typeof value === 'string' ? value.trim().toUpperCase() : value),
      z.enum(['PRESENT', 'ABSENT', 'LATE']),
    ),
    total_work_minutes: z.preprocess((val) => {
      if (val === undefined || val === null || val === '') return 0;
      if (typeof val === 'number' && Number.isFinite(val)) return Math.trunc(val);
      if (typeof val === 'string') {
        const cleaned = val.trim().replace(/,/g, '');
        if (cleaned === '') return 0;
        const n = Number(cleaned);
        if (Number.isFinite(n)) return Math.trunc(n);
      }
      return val;
    }, z.number().int().nonnegative()),
    overtime_minutes: z.preprocess(emptyStringToUndefined, nonNegativeIntFromForm.optional()),
  })
  .superRefine((row, ctx) => {
    if (row.status === 'ABSENT') {
      if (row.total_work_minutes !== 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'total_work_minutes must be 0 for ABSENT',
          path: ['total_work_minutes'],
        });
      }
    } else if (row.total_work_minutes === undefined || row.total_work_minutes <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'total_work_minutes must be greater than 0 for PRESENT/LATE',
        path: ['total_work_minutes'],
      });
    }
  });

export type AttendanceBulkImportRow = z.infer<typeof attendanceBulkImportRowSchema>;

export const attendanceBulkImportQuerySchema = z
  .object({
    dry_run: z
      .preprocess((val) => val === 'true' || val === true, z.boolean())
      .optional()
      .default(false),
    month: z.coerce.number().int().min(1).max(12).optional(),
    year: z.coerce.number().int().min(2000).max(2100).optional(),
  })
  .superRefine((data, ctx) => {
    const hasMonth = data.month !== undefined;
    const hasYear = data.year !== undefined;
    if (hasMonth !== hasYear) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'month and year must both be provided together',
        path: hasMonth ? ['year'] : ['month'],
      });
    }
  });

export const ATTENDANCE_BULK_IMPORT_HEADER_ALIASES: Record<
  string,
  (typeof ATTENDANCE_BULK_IMPORT_CANONICAL_HEADERS)[number]
> = {
  official_email: 'official_email',
  email: 'official_email',
  'official email': 'official_email',
  officialemail: 'official_email',
  date: 'date',
  attendance_date: 'date',
  'attendance date': 'date',
  status: 'status',
  attendance_status: 'status',
  'attendance status': 'status',
  total_work_minutes: 'total_work_minutes',
  'total work minutes': 'total_work_minutes',
  totalworkminutes: 'total_work_minutes',
  work_minutes: 'total_work_minutes',
  'work minutes': 'total_work_minutes',
  overtime_minutes: 'overtime_minutes',
  'overtime minutes': 'overtime_minutes',
  overtimeminutes: 'overtime_minutes',
  ot_minutes: 'overtime_minutes',
  'ot minutes': 'overtime_minutes',
};

export function normalizeAttendanceBulkImportHeader(
  header: unknown,
): (typeof ATTENDANCE_BULK_IMPORT_CANONICAL_HEADERS)[number] | null {
  if (header === undefined || header === null) return null;
  const key = String(header).trim().toLowerCase();
  if (!key) return null;
  return ATTENDANCE_BULK_IMPORT_HEADER_ALIASES[key] ?? null;
}
