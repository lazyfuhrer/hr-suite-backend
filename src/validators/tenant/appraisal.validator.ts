import { z } from 'zod';
import { onboardingFinanceSchema } from './onboarding.validator';

export const createAppraisalBodySchema = z
  .object({
    start_from: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'start_from must be YYYY-MM'),
    hike_percentage: z.coerce.number().nonnegative().optional(),
    finance: onboardingFinanceSchema,
  })
  .passthrough();

export const appraisalHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
