import { UserLocationSnapshot } from '../models/UserLocationSnapshot';

export type CreateLocationSnapshotInput = {
  latitude: number;
  longitude: number;
  captured_at?: Date;
  prompt_slot_key?: string;
};

export type ListLocationSnapshotsFilters = {
  userId?: string;
  from?: Date;
  to?: Date;
  page: number;
  limit: number;
};

export async function createLocationSnapshot(
  orgId: string,
  userId: string,
  input: CreateLocationSnapshotInput,
): Promise<UserLocationSnapshot> {
  return UserLocationSnapshot.query().insert({
    org_id: orgId,
    user_id: userId,
    latitude: String(input.latitude),
    longitude: String(input.longitude),
    captured_at: input.captured_at ?? new Date(),
    prompt_slot_key: input.prompt_slot_key ?? null,
    source: 'location_request',
  });
}

export async function listLocationSnapshots(
  orgId: string,
  filters: ListLocationSnapshotsFilters,
): Promise<{
  data: UserLocationSnapshot[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}> {
  const query = UserLocationSnapshot.query()
    .where('org_id', orgId)
    .modify((qb) => {
      if (filters.userId) {
        qb.where('user_id', filters.userId);
      }
      if (filters.from) {
        qb.where('captured_at', '>=', filters.from);
      }
      if (filters.to) {
        qb.where('captured_at', '<=', filters.to);
      }
    })
    .orderBy('captured_at', 'desc');

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
