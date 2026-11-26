import type { QueryBuilder } from 'objection';

import type { User } from '../models/User';
import { UserExit } from '../models/UserExit';

export const formatExitForProfile = (exit: UserExit | null | undefined) => {
  if (!exit) {
    return null;
  }

  return {
    id: exit.id,
    status: exit.status,
    exit_type: exit.exit_type,
    exit_reason: exit.exit_reason ?? null,
    notice_start_date: exit.notice_start_date ?? null,
    last_working_day: exit.last_working_day,
    exited_at: exit.exited_at ?? null,
    initiated_at: exit.initiated_at,
    confirmed_at: exit.confirmed_at ?? null,
    cancelled_at: exit.cancelled_at ?? null,
  };
};

export const findActiveExit = async (
  orgId: string,
  userId: string,
): Promise<UserExit | undefined> => {
  return UserExit.query()
    .where({ org_id: orgId, user_id: userId })
    .whereIn('status', ['SCHEDULED', 'ON_NOTICE', 'COMPLETED'])
    .orderBy('created_at', 'desc')
    .first();
};

/** Count separations in a period: user_exits.exited_at (canonical) + legacy INACTIVE/deleted_at. */
export const applyResignedUsersInPeriodFilter = (
  query: QueryBuilder<User, User[]>,
  orgId: string,
  periodStart: Date,
  periodEnd: Date,
): QueryBuilder<User, User[]> => {
  return query.where((builder) => {
    builder
      .whereExists(
        UserExit.query()
          .select(1)
          .whereColumn('user_exits.user_id', 'users.id')
          .where('user_exits.org_id', orgId)
          .where('user_exits.status', 'COMPLETED')
          .whereBetween('user_exits.exited_at', [periodStart, periodEnd]),
      )
      .orWhere((legacy) => {
        legacy
          .where('users.status', 'INACTIVE')
          .whereBetween('users.updated_at', [periodStart, periodEnd])
          .whereNotExists(
            UserExit.query()
              .select(1)
              .whereColumn('user_exits.user_id', 'users.id')
              .where('user_exits.org_id', orgId)
              .where('user_exits.status', 'COMPLETED'),
          );
      })
      .orWhereBetween('users.deleted_at', [periodStart, periodEnd]);
  });
};
