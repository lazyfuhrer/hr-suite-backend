import { z } from 'zod';

export const requestCancelBodySchema = z.object({
  comment: z.string().min(1).optional(),
});

export type RequestCancelBody = z.infer<typeof requestCancelBodySchema>;
