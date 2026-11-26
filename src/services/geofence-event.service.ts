import { GeofenceEvent } from '../models/GeofenceEvent';
import type { ListGeofenceEventsQuery } from '../validators';

export type ListGeofenceEventsFilters = ListGeofenceEventsQuery;

/** UTC start/end of a calendar day for YYYY-MM-DD. */
function utcDayBounds(dateStr: string): { from: Date; to: Date } {
  const from = new Date(`${dateStr}T00:00:00.000Z`);
  const to = new Date(`${dateStr}T23:59:59.999Z`);
  return { from, to };
}

export async function listGeofenceEvents(
  orgId: string,
  filters: ListGeofenceEventsFilters,
): Promise<{
  data: GeofenceEvent[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}> {
  let from = filters.from;
  let to = filters.to;
  if (filters.date) {
    const bounds = utcDayBounds(filters.date);
    from = bounds.from;
    to = bounds.to;
  }

  const baseQuery = GeofenceEvent.query()
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
    });

  const countRow = await baseQuery.clone().clearSelect().countDistinct('id as count').first();
  const total = Number((countRow as { count?: string | number } | undefined)?.count ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / filters.limit));
  const safePage = Math.min(filters.page, totalPages);
  const offset = (safePage - 1) * filters.limit;

  const rows = await baseQuery
    .clone()
    .withGraphFetched('geofence')
    .orderBy('recorded_at', 'desc')
    .limit(filters.limit)
    .offset(offset);

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
