import { z } from 'zod';

const positiveNumberFromQuery = z.preprocess((val) => {
  if (val === undefined || val === null || val === '') return undefined;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const n = Number(val);
    if (Number.isFinite(n)) return n;
  }
  return val;
}, z.number().positive());

const upperEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(
    (value) => (typeof value === 'string' ? value.toUpperCase() : value),
    z.enum(values),
  );

export const pfValueTypeSchema = upperEnum(['PERCENTAGE', 'FIXED']);

const pctSchema = z.number().min(0).max(100);

export const upsertOrgPayrollSettingsSchema = z.object({
  basic_pct: pctSchema,
  hra_pct_of_basic: pctSchema,
  employer_pf: z.object({
    type: pfValueTypeSchema,
    value: z.number().nonnegative(),
  }),
  employee_pf: z.object({
    type: pfValueTypeSchema,
    value: z.number().nonnegative(),
  }),
  professional_tax_annual: z.number().nonnegative(),
});

export const payrollSettingsPreviewQuerySchema = z.object({
  annual_ctc: positiveNumberFromQuery,
});
