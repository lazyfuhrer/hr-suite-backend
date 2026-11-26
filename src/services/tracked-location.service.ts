import { randomUUID } from 'crypto';

import { UserTrackedLocation } from '../models/UserTrackedLocation';
import type { TransistorsoftLocation } from '../validators';

function toOptionalString(value: number | undefined): string | null {
  return value === undefined ? null : String(value);
}

function parseRecordedAt(timestamp: string | number | undefined): Date {
  if (timestamp === undefined) {
    return new Date();
  }

  if (typeof timestamp === 'number') {
    // Epoch seconds vs milliseconds
    const ms = timestamp < 1e12 ? timestamp * 1000 : timestamp;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? new Date() : date;
  }

  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function resolveRecordedAt(location: TransistorsoftLocation): Date {
  // Prefer SDK recorded_at when present; fall back to native timestamp.
  return parseRecordedAt(location.recorded_at ?? location.timestamp);
}

export type TrackedLocationInsert = {
  org_id: string;
  user_id: string;
  sdk_uuid: string;
  latitude: string;
  longitude: string;
  accuracy: string | null;
  speed: string | null;
  heading: string | null;
  altitude: string | null;
  activity_type: string | null;
  activity_confidence: number | null;
  battery_level: string | null;
  battery_is_charging: boolean | null;
  event: string | null;
  is_moving: boolean | null;
  odometer: string | null;
  age: number | null;
  extras: Record<string, unknown> | null;
  geofence_identifier: string | null;
  geofence_action: string | null;
  recorded_at: Date;
};

export function normalizeTrackedLocation(
  orgId: string,
  userId: string,
  location: TransistorsoftLocation,
): TrackedLocationInsert | null {
  // Intermediate accuracy samples are not persisted by the SDK and should be skipped.
  if (location.sample === true) {
    return null;
  }

  return {
    org_id: orgId,
    user_id: userId,
    sdk_uuid: location.uuid?.trim() || randomUUID(),
    latitude: String(location.coords.latitude),
    longitude: String(location.coords.longitude),
    accuracy: toOptionalString(location.coords.accuracy),
    speed: toOptionalString(location.coords.speed),
    heading: toOptionalString(location.coords.heading),
    altitude: toOptionalString(location.coords.altitude),
    activity_type: location.activity?.type ?? null,
    activity_confidence:
      location.activity?.confidence === undefined ? null : Math.round(location.activity.confidence),
    battery_level: toOptionalString(location.battery?.level),
    battery_is_charging: location.battery?.is_charging ?? null,
    event: location.event ?? null,
    is_moving: location.is_moving ?? null,
    odometer: toOptionalString(location.odometer),
    age: location.age === undefined ? null : Math.round(location.age),
    extras: location.extras ?? null,
    geofence_identifier: location.geofence?.identifier ?? null,
    geofence_action: location.geofence?.action ?? null,
    recorded_at: resolveRecordedAt(location),
  };
}

export async function persistTrackedLocations(
  orgId: string,
  userId: string,
  locations: TransistorsoftLocation[],
): Promise<{ accepted: number; skipped: number }> {
  const rows: TrackedLocationInsert[] = [];
  let skipped = 0;

  for (const location of locations) {
    const row = normalizeTrackedLocation(orgId, userId, location);
    if (!row) {
      skipped += 1;
      continue;
    }
    rows.push(row);
  }

  if (rows.length === 0) {
    return { accepted: 0, skipped };
  }

  // Deduplicate within the same request by sdk_uuid (keep first)
  const seen = new Set<string>();
  const uniqueRows = rows.filter((row) => {
    if (seen.has(row.sdk_uuid)) {
      skipped += 1;
      return false;
    }
    seen.add(row.sdk_uuid);
    return true;
  });

  // Idempotent Transistorsoft retries: skip sdk_uuids already present for this org.
  // Pre-check is required — knex/objection `.returning()` with ON CONFLICT DO NOTHING
  // can still report input rows, which inflated `accepted` on duplicates.
  const candidateUuids = uniqueRows.map((r) => r.sdk_uuid);
  const alreadyPersisted = await UserTrackedLocation.query()
    .where('org_id', orgId)
    .whereIn('sdk_uuid', candidateUuids)
    .select('sdk_uuid');
  const existingUuidSet = new Set(alreadyPersisted.map((r) => r.sdk_uuid));
  const toInsert = uniqueRows.filter((r) => !existingUuidSet.has(r.sdk_uuid));
  skipped += uniqueRows.length - toInsert.length;

  if (toInsert.length > 0) {
    await UserTrackedLocation.query().insert(toInsert).onConflict(['org_id', 'sdk_uuid']).ignore();
  }

  return { accepted: toInsert.length, skipped };
}

export type ListTrackedLocationsFilters = {
  userId?: string;
  from?: Date;
  to?: Date;
  date?: string;
  page: number;
  limit: number;
};

/** UTC start/end of a calendar day for YYYY-MM-DD. */
function utcDayBounds(dateStr: string): { from: Date; to: Date } {
  const from = new Date(`${dateStr}T00:00:00.000Z`);
  const to = new Date(`${dateStr}T23:59:59.999Z`);
  return { from, to };
}

export async function listTrackedLocations(
  orgId: string,
  filters: ListTrackedLocationsFilters,
): Promise<{
  data: UserTrackedLocation[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}> {
  let from = filters.from;
  let to = filters.to;
  if (filters.date) {
    const bounds = utcDayBounds(filters.date);
    from = bounds.from;
    to = bounds.to;
  }

  const query = UserTrackedLocation.query()
    .where('org_id', orgId)
    .modify((qb) => {
      if (filters.userId) {
        qb.where('user_id', filters.userId);
      }
      if (from) {
        qb.where('recorded_at', '>=', from);
      }
      if (to) {
        qb.where('recorded_at', '<=', to);
      }
    })
    .orderBy('recorded_at', 'desc');

  const countRow = await query
    .clone()
    .clearSelect()
    .clearOrder()
    .countDistinct('id as count')
    .first();
  const total = Number((countRow as { count?: string | number } | undefined)?.count ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / filters.limit));
  const safePage = Math.min(filters.page, totalPages);
  const offset = (safePage - 1) * filters.limit;

  const rows = await query.clone().limit(filters.limit).offset(offset);

  return {
    data: rows,
    pagination: {
      page: safePage,
      limit: filters.limit,
      total,
      totalPages,
    },
  };
}
