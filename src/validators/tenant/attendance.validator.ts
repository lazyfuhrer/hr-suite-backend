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

const numberField = z.preprocess((value) => {
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? value : parsed;
  }
  return value;
}, z.number().finite());

const latitudeField = numberField.pipe(z.number().min(-90).max(90));
const longitudeField = numberField.pipe(z.number().min(-180).max(180));

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

// Helper to accept enums case-insensitively by uppercasing incoming strings
const upperEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(
    (value) => (typeof value === 'string' ? value.toUpperCase() : value),
    z.enum(values),
  );

export const attendanceClockInSchema = z.object({
  latitude: numberField,
  longitude: numberField,
});

export const attendanceClockOutSchema = z.object({
  latitude: numberField,
  longitude: numberField,
});

// For face clock, only threshold comes in the body (multipart/form-data).
export const attendanceFaceClockSchema = z.object({
  threshold: z
    .preprocess((value) => {
      if (value === undefined || value === null || value === '') return undefined;
      if (typeof value === 'number') return value;
      if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
      return value;
    }, z.number().min(0).max(100))
    .optional(),
  latitude: latitudeField.optional(),
  longitude: longitudeField.optional(),
});

export const attendanceFaceClockLocationVerifySchema = z.object({
  latitude: numberField,
  longitude: numberField,
});

export const attendanceFaceVerifyAndClockInSchema = z.object({
  threshold: z
    .preprocess((value) => {
      if (value === undefined || value === null || value === '') return undefined;
      if (typeof value === 'number') return value;
      if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
      return value;
    }, z.number().min(0).max(100))
    .optional(),
  latitude: latitudeField.optional(),
  longitude: longitudeField.optional(),
});

export const attendanceUserAllowedLocationCreateSchema = z.object({
  latitude: latitudeField,
  longitude: longitudeField,
  radius_meters: z.coerce.number().int().min(20).max(5000).optional().default(150),
  label: z.string().trim().min(1).max(255).optional(),
});

export const attendanceUserAllowedLocationUserParamsSchema = z.object({
  userId: z.string().uuid(),
});

export const attendanceUserAllowedLocationDeleteParamsSchema = z.object({
  userId: z.string().uuid(),
  locationId: z.string().uuid(),
});

export const attendanceUserAllowedLocationStatusUpdateSchema = z.object({
  is_active: z.preprocess((value) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const v = value.trim().toLowerCase();
      if (v === 'true') return true;
      if (v === 'false') return false;
    }
    return value;
  }, z.boolean()),
});

export const attendanceUserClockInLocationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

export const attendanceBreakStartSchema = z.object({
  break_type: upperEnum(['LUNCH', 'TEA']),
});

const dateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
  .refine(isValidDateString, 'Invalid calendar date');

export const attendanceCorrectionCreateSchema = z.object({
  attendance_log_id: z.number().int().positive().optional(),
  request_date: dateStringSchema,
  requested_clock_in: z.string().min(1),
  requested_clock_out: z.string().min(1),
  reason: z.string().min(1).optional(),
});

// Regularize Attendance (UI flow) - correct a single punch time or multiple breaks
export const attendanceRegularizationCreateSchema = z
  .object({
    request_date: dateStringSchema,
    // Old values: MISSING_IN, MISSING_OUT, WRONG_IN, WRONG_OUT
    // New values: CLOCK_IN, CLOCK_OUT, BREAKS
    // All values are allowed for backward compatibility
    wrong_punch_type: upperEnum([
      'MISSING_IN',
      'MISSING_OUT',
      'WRONG_IN',
      'WRONG_OUT',
      'CLOCK_IN',
      'CLOCK_OUT',
      'BREAKS',
    ]),
    corrected_time: z.string().regex(/^\d{2}:\d{2}$/, 'corrected_time must be in HH:MM format'),
    reason: z.string().min(1).optional(),
    attachment_url: z.string().url().optional(),
    // Optional full-day times used when there is no completed attendance log for that date.
    // These mirror the fields from attendanceCorrectionCreateSchema and are only required
    // in the controller when we cannot derive both clock-in and clock-out from an existing log.
    requested_clock_in: z.string().min(1).optional(),
    requested_clock_out: z.string().min(1).optional(),
    break_corrections: z
      .array(
        z.object({
          break_type: upperEnum(['LUNCH', 'TEA']),
          corrected_start_time: z
            .string()
            .regex(/^\d{2}:\d{2}$/, 'corrected_start_time must be in HH:MM format'),
          corrected_end_time: z
            .string()
            .regex(/^\d{2}:\d{2}$/, 'corrected_end_time must be in HH:MM format'),
        }),
      )
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (data.wrong_punch_type === 'BREAKS') {
      if (!data.break_corrections || data.break_corrections.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['break_corrections'],
          message:
            'break_corrections is required and must contain at least one entry when wrong_punch_type is BREAKS',
        });
      }
    }
  });

// Regularization details helper – returns existing punches/breaks for a given date
export const attendanceRegularizationDetailsQuerySchema = z.object({
  request_date: dateStringSchema,
});

export const attendanceCorrectionApproveSchema = z.object({
  requestId: z.string().uuid(),
  action: upperEnum(['APPROVE', 'REJECT']),
  comment: z.string().min(1).optional(),
});

// REST-ier status update schema for PATCH /attendance/requests/:id/status
export const attendanceCorrectionStatusUpdateSchema = z.object({
  status: upperEnum(['APPROVED', 'REJECTED', 'CANCELLED']),
  comment: z.string().min(1).optional(),
});

export const attendanceCorrectionListMyQuerySchema = z
  .object({
    start_date: dateStringSchema.optional(),
    end_date: dateStringSchema.optional(),
    from_date: dateStringSchema.optional(),
    to_date: dateStringSchema.optional(),
    status: upperEnum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
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
      // allow neither or only one (treated as no range)
      return true;
    },
    { message: 'start_date must be before or equal to end_date' },
  );

export const attendanceCorrectionListPendingQuerySchema = z
  .object({
    start_date: dateStringSchema.optional(),
    end_date: dateStringSchema.optional(),
    from_date: dateStringSchema.optional(),
    to_date: dateStringSchema.optional(),
    step: upperEnum(['MANAGER', 'HR', 'ANY']).optional().default('ANY'),
    // One or more overall request statuses to include; when omitted, all statuses are included.
    // Accept both status=<one> and statuses=<one|many> for convenience.
    status: upperEnum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
    statuses: z
      .preprocess(
        (value) => {
          if (Array.isArray(value)) return value;
          if (typeof value === 'string') return [value];
          return value;
        },
        z.array(upperEnum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'])),
      )
      .optional(),
    page: intFromQuery(1, 10_000).optional().default(1),
    limit: intFromQuery(1, 100).optional().default(10),
  })
  .refine(
    (data) => {
      const hasFrom = Boolean(data.from_date);
      const hasTo = Boolean(data.to_date);
      return hasFrom === hasTo;
    },
    { message: 'from_date must be paired with to_date' },
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

export const attendanceCalendarQuerySchema = z
  .object({
    start_date: dateStringSchema.optional(),
    end_date: dateStringSchema.optional(),
    month: z.coerce.number().int().min(1).max(12).optional(),
    year: z.coerce.number().int().min(2000).max(2100).optional(),
  })
  .refine(
    (data) => {
      // Either provide start_date and end_date, or month and year
      const hasDateRange = data.start_date && data.end_date;
      const hasMonthYear = data.month && data.year;
      return hasDateRange || hasMonthYear;
    },
    {
      message: 'Either provide start_date and end_date, or month and year',
    },
  )
  .refine(
    (data) => {
      if (data.start_date && data.end_date) {
        const start = new Date(data.start_date);
        const end = new Date(data.end_date);
        return start <= end;
      }
      return true;
    },
    {
      message: 'start_date must be before or equal to end_date',
    },
  );

export const attendanceWeeklySummaryQuerySchema = z
  .object({
    start_date: dateStringSchema,
    end_date: dateStringSchema,
  })
  .refine(
    (data) => {
      const start = new Date(data.start_date);
      const end = new Date(data.end_date);
      return start <= end;
    },
    {
      message: 'start_date must be before or equal to end_date',
    },
  );

export const attendanceMonthlyPerformanceQuerySchema = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000).max(2100),
});

// Admin/HR attendance dashboard (org-level) – cards + multi-month overview
export const attendanceOrgDashboardQuerySchema = z.object({
  date: dateStringSchema.optional(), // focus date; defaults to today
  months: z.coerce.number().int().min(1).max(12).optional(), // how many months in overview; default: 6
});

// Admin/HR employee attendance list (org-level) – table view
export const attendanceOrgEmployeeListQuerySchema = z
  .object({
    // date is now optional; when omitted, the table shows each employee's latest attendance snapshot
    date: dateStringSchema.optional(),
    from_date: dateStringSchema.optional(),
    to_date: dateStringSchema.optional(),
    month: intFromQuery(1, 12).optional(),
    year: intFromQuery(2000, 2100).optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(10),
    department_id: z.string().uuid().optional(),
    department: z.string().uuid().optional(), // Alias for department_id
    work_model: upperEnum(['ONSITE', 'HYBRID', 'REMOTE']).optional(),
    status: upperEnum(['ON_TIME', 'LATE', 'LEAVE', 'ABSENT', 'HALF_DAY', 'WFH', 'ALL'])
      .optional()
      .default('ALL'),
    leave_session: upperEnum(['FIRST_HALF', 'SECOND_HALF', 'ANY_HALF']).optional(),
    search: z.string().min(1).max(255).optional(),
    sort_by: upperEnum(['NAME', 'STATUS', 'DATE']).optional().default('NAME'),
    sort_dir: upperEnum(['ASC', 'DESC']).optional().default('ASC'),
  })
  .refine(
    (data) => {
      // Either both from_date and to_date are provided or neither.
      const hasFrom = Boolean(data.from_date);
      const hasTo = Boolean(data.to_date);
      return hasFrom === hasTo;
    },
    {
      message: 'from_date and to_date must be provided together',
      path: ['from_date'],
    },
  )
  .refine(
    (data) => {
      if (data.date && (data.from_date || data.to_date)) {
        return false;
      }
      return true;
    },
    {
      message: 'Provide either date, or from_date and to_date',
      path: ['date'],
    },
  )
  .refine(
    (data) => {
      if (data.from_date && data.to_date) {
        return new Date(data.from_date) <= new Date(data.to_date);
      }
      return true;
    },
    {
      message: 'from_date must be before or equal to to_date',
      path: ['from_date'],
    },
  )
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
  );

/** Excel download: requires month/year or from_date/to_date. */
export const attendanceExcelDownloadQuerySchema = attendanceOrgEmployeeListQuerySchema.refine(
  (data) => {
    const hasMonthYear = data.month !== undefined && data.year !== undefined;
    const hasFromTo = Boolean(data.from_date) && Boolean(data.to_date);
    return hasMonthYear || hasFromTo;
  },
  {
    message: 'Either month and year, or from_date and to_date are required for Excel download',
    path: ['month'],
  },
);

export const attendanceAdminCardsSummaryQuerySchema = z
  .object({
    // Optional focus date; defaults to today
    date: dateStringSchema.optional(),
    from_date: dateStringSchema.optional(),
    to_date: dateStringSchema.optional(),
  })
  .refine(
    (data) => {
      const hasFrom = Boolean(data.from_date);
      const hasTo = Boolean(data.to_date);
      return hasFrom === hasTo;
    },
    {
      message: 'from_date and to_date must be provided together',
      path: ['from_date'],
    },
  )
  .refine(
    (data) => {
      if (data.date && (data.from_date || data.to_date)) {
        return false;
      }
      return true;
    },
    {
      message: 'Provide either date, or from_date and to_date',
      path: ['date'],
    },
  )
  .refine(
    (data) => {
      if (data.from_date && data.to_date) {
        return new Date(data.from_date) <= new Date(data.to_date);
      }
      return true;
    },
    {
      message: 'from_date must be before or equal to to_date',
      path: ['from_date'],
    },
  );
