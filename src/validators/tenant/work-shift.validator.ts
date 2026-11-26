import { z } from 'zod';

const timeRegex = /^([0-1][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/;

export const createWorkShiftSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  start_time: z.string().regex(timeRegex, 'Invalid time format. Use HH:MM:SS'),
  end_time: z.string().regex(timeRegex, 'Invalid time format. Use HH:MM:SS'),
  break_start_time: z.string().regex(timeRegex, 'Invalid time format. Use HH:MM:SS'),
  break_end_time: z.string().regex(timeRegex, 'Invalid time format. Use HH:MM:SS'),
  break_duration_mins: z.coerce.number().int().nonnegative().default(60),
});

export const updateWorkShiftSchema = createWorkShiftSchema;
