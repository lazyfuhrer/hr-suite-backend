import { z } from 'zod';

export const TRACKED_LOCATION_BATCH_MAX = 250;

const numberField = z.preprocess((value) => {
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? value : parsed;
  }
  return value;
}, z.number().finite());

const latitudeField = numberField.pipe(z.number().min(-90).max(90));
const longitudeField = numberField.pipe(z.number().min(-180).max(180));

const coordsSchema = z
  .object({
    latitude: latitudeField,
    longitude: longitudeField,
    accuracy: numberField.optional(),
    speed: numberField.optional(),
    heading: numberField.optional(),
    altitude: numberField.optional(),
    ellipsoidal_altitude: numberField.optional(),
  })
  .passthrough();

const activitySchema = z
  .object({
    type: z.string().trim().min(1).max(32).optional(),
    confidence: numberField.pipe(z.number().min(0).max(100)).optional(),
  })
  .passthrough();

const batterySchema = z
  .object({
    level: numberField.optional(),
    is_charging: z.boolean().optional(),
  })
  .passthrough();

const geofenceSchema = z
  .object({
    identifier: z.string().trim().min(1).max(128).optional(),
    action: z.string().trim().min(1).max(16).optional(),
  })
  .passthrough();

const timestampField = z.union([z.string().min(1), z.number().finite()]);

export const transistorsoftLocationSchema = z
  .object({
    coords: coordsSchema,
    uuid: z.string().trim().min(1).max(64).optional(),
    timestamp: timestampField.optional(),
    recorded_at: timestampField.optional(),
    age: numberField.optional(),
    event: z.string().trim().min(1).max(32).optional(),
    is_moving: z.boolean().optional(),
    odometer: numberField.optional(),
    odometer_error: numberField.optional(),
    mock: z.boolean().optional(),
    sample: z.boolean().optional(),
    extras: z.record(z.string(), z.unknown()).optional(),
    activity: activitySchema.optional(),
    battery: batterySchema.optional(),
    geofence: geofenceSchema.optional(),
  })
  .passthrough();

export type TransistorsoftLocation = z.infer<typeof transistorsoftLocationSchema>;

const locationOrBatch = z.union([
  transistorsoftLocationSchema,
  z.array(transistorsoftLocationSchema).min(1).max(TRACKED_LOCATION_BATCH_MAX),
]);

export const submitTrackedLocationsSchema = z
  .object({
    location: locationOrBatch.optional(),
    locations: z
      .array(transistorsoftLocationSchema)
      .min(1)
      .max(TRACKED_LOCATION_BATCH_MAX)
      .optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    const hasLocation = value.location !== undefined;
    const hasLocations = value.locations !== undefined;

    if (!hasLocation && !hasLocations) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide either "location" or "locations"',
        path: ['location'],
      });
    }
  });

export type SubmitTrackedLocationsInput = z.infer<typeof submitTrackedLocationsSchema>;

/** Flatten single / batch Transistorsoft payloads into a location list. */
export function extractTrackedLocations(
  body: SubmitTrackedLocationsInput,
): TransistorsoftLocation[] {
  const items: TransistorsoftLocation[] = [];

  if (body.locations) {
    items.push(...body.locations);
  }

  if (body.location) {
    if (Array.isArray(body.location)) {
      items.push(...body.location);
    } else {
      items.push(body.location);
    }
  }

  return items;
}

export const listTrackedLocationsQuerySchema = z
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

export type ListTrackedLocationsQuery = z.infer<typeof listTrackedLocationsQuerySchema>;

export const updateUserLocationTrackingSchema = z
  .object({
    location_tracking_enabled: z.boolean().nullable(),
  })
  .strict();

export type UpdateUserLocationTrackingInput = z.infer<typeof updateUserLocationTrackingSchema>;

export const userLocationTrackingParamsSchema = z.object({
  userId: z.string().uuid(),
});
