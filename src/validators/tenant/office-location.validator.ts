import { z } from 'zod';

const numberField = z.preprocess((value) => {
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? value : parsed;
  }
  return value;
}, z.number().finite());

export const createOfficeLocationSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  latitude: numberField,
  longitude: numberField,
  radius_meters: z.coerce.number().int().positive().default(100),
  address: z.string().trim().min(1).optional(),
});

export const updateOfficeLocationSchema = createOfficeLocationSchema.partial();
