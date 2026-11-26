import { z } from 'zod';

const numberField = z.preprocess((value) => {
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? value : parsed;
  }
  return value;
}, z.number().finite());

const latitudeField = numberField.pipe(z.number().min(-90).max(90));
const longitudeField = numberField.pipe(z.number().min(-180).max(180));

export const submitLocationSnapshotSchema = z.object({
  latitude: latitudeField,
  longitude: longitudeField,
  captured_at: z.coerce.date().optional(),
  prompt_slot_key: z.string().trim().min(1).max(32).optional(),
});

export const listLocationSnapshotsQuerySchema = z.object({
  userId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
});
