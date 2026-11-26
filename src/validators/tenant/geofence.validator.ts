import { z } from 'zod';

const numberField = z.preprocess((value) => {
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? value : parsed;
  }
  return value;
}, z.number().finite());

const geofenceFieldsSchema = z.object({
  landmark: z.string().trim().min(1, 'Landmark is required').max(255),
  latitude: numberField,
  longitude: numberField,
  radius_meters: z.coerce.number().int().positive().default(100),
});

export const createGeofenceSchema = geofenceFieldsSchema.extend({
  org_id: z.string().uuid(),
  user_id: z.string().uuid(),
});

export const updateGeofenceSchema = createGeofenceSchema;

export const createGeofenceEventSchema = z
  .object({
    event_type: z.enum(['in', 'out']),
    latitude: numberField.optional(),
    longitude: numberField.optional(),
    device_token: z.string().trim().min(1).optional(),
    platform: z.enum(['apns', 'gcm', 'web']).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.device_token && !data.platform) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'platform is required when device_token is provided',
        path: ['platform'],
      });
    }
  });

export const listGeofenceEventsQuerySchema = z
  .object({
    userId: z.string().uuid().optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
      .optional(),
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  })
  .superRefine((data, ctx) => {
    if (data.date && (data.from !== undefined || data.to !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'date cannot be used together with from or to',
        path: ['date'],
      });
    }
  });

export type ListGeofenceEventsQuery = z.infer<typeof listGeofenceEventsQuerySchema>;
