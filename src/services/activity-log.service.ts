import { ActivityLog } from '../models/ActivityLog';
import { logger } from '../config/logger';

export const ACTIVITY_ENTITY_TYPES = {
  LEAVE_REQUEST: 'LEAVE_REQUEST',
  WFH_REQUEST: 'WFH_REQUEST',
  REIMBURSEMENT_REQUEST: 'REIMBURSEMENT_REQUEST',
  ATTENDANCE_REQUEST: 'ATTENDANCE_REQUEST',
  ATTENDANCE_LOG: 'ATTENDANCE_LOG',
  USER: 'USER',
} as const;

export const ACTIVITY_TYPES = {
  LEAVE_APPLIED: 'LEAVE_APPLIED',
  LEAVE_APPROVED: 'LEAVE_APPROVED',
  LEAVE_REJECTED: 'LEAVE_REJECTED',
  LEAVE_CANCELLED: 'LEAVE_CANCELLED',
  WFH_APPLIED: 'WFH_APPLIED',
  WFH_APPROVED: 'WFH_APPROVED',
  WFH_REJECTED: 'WFH_REJECTED',
  WFH_CANCELLED: 'WFH_CANCELLED',
  REIMBURSEMENT_APPLIED: 'REIMBURSEMENT_APPLIED',
  REIMBURSEMENT_APPROVED: 'REIMBURSEMENT_APPROVED',
  REIMBURSEMENT_REJECTED: 'REIMBURSEMENT_REJECTED',
  REIMBURSEMENT_CANCELLED: 'REIMBURSEMENT_CANCELLED',
  REIMBURSEMENT_MONTH_PAID: 'REIMBURSEMENT_MONTH_PAID',
  ATTENDANCE_REQUEST_CREATED: 'ATTENDANCE_REQUEST_CREATED',
  ATTENDANCE_REQUEST_APPROVED: 'ATTENDANCE_REQUEST_APPROVED',
  ATTENDANCE_REQUEST_REJECTED: 'ATTENDANCE_REQUEST_REJECTED',
  ATTENDANCE_REQUEST_CANCELLED: 'ATTENDANCE_REQUEST_CANCELLED',
  CLOCKED_IN: 'CLOCKED_IN',
  CLOCKED_OUT: 'CLOCKED_OUT',
  EXIT_INITIATED: 'EXIT_INITIATED',
  EXIT_SCHEDULED: 'EXIT_SCHEDULED',
  EXIT_NOTICE_STARTED: 'EXIT_NOTICE_STARTED',
  EXIT_CONFIRMED: 'EXIT_CONFIRMED',
  EXIT_AUTO_CONFIRMED: 'EXIT_AUTO_CONFIRMED',
  EXIT_CANCELLED: 'EXIT_CANCELLED',
  EXIT_IMMEDIATE: 'EXIT_IMMEDIATE',
} as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[keyof typeof ACTIVITY_TYPES];
export type ActivityEntityType = (typeof ACTIVITY_ENTITY_TYPES)[keyof typeof ACTIVITY_ENTITY_TYPES];

type RecordActivityInput = {
  org_id: string;
  actor_user_id?: string | null;
  target_user_id?: string | null;
  entity_type: ActivityEntityType;
  entity_id?: string | null;
  activity_type: ActivityType;
  metadata?: Record<string, unknown> | null;
};

type ListActivityInput = {
  org_id: string;
  page: number;
  limit: number;
  activity_type?: ActivityType;
  actor_user_id?: string;
  target_user_id?: string;
  from_date?: string;
  to_date?: string;
};

const buildPaginatedResponse = <T>(page: number, limit: number, total: number, items: T[]) => ({
  page,
  limit,
  total,
  total_pages: Math.max(1, Math.ceil(total / limit)),
  items,
});

export class ActivityLogService {
  static async recordActivity(input: RecordActivityInput): Promise<ActivityLog> {
    return ActivityLog.query().insert({
      org_id: input.org_id,
      actor_user_id: input.actor_user_id ?? null,
      target_user_id: input.target_user_id ?? null,
      entity_type: input.entity_type,
      entity_id: input.entity_id ?? null,
      activity_type: input.activity_type,
      metadata: input.metadata ?? null,
    } as any);
  }

  static async recordActivitySafely(input: RecordActivityInput): Promise<void> {
    try {
      await ActivityLogService.recordActivity(input);
    } catch (err) {
      logger.error({ err, activity: input }, 'Failed to record activity log');
    }
  }

  static async listOrgActivities(input: ListActivityInput) {
    const baseQuery = ActivityLog.query()
      .alias('al')
      .leftJoin('users as actor', 'actor.id', 'al.actor_user_id')
      .leftJoin('users as target', 'target.id', 'al.target_user_id')
      .where('al.org_id', input.org_id);

    if (input.activity_type) {
      baseQuery.where('al.activity_type', input.activity_type);
    }
    if (input.actor_user_id) {
      baseQuery.where('al.actor_user_id', input.actor_user_id);
    }
    if (input.target_user_id) {
      baseQuery.where('al.target_user_id', input.target_user_id);
    }
    if (input.from_date && input.to_date) {
      baseQuery.whereBetween('al.created_at', [
        `${input.from_date}T00:00:00.000Z`,
        `${input.to_date}T23:59:59.999Z`,
      ]);
    }

    const totalRow = await baseQuery.clone().countDistinct('al.id as count').first();
    const total = Number((totalRow as { count?: string | number } | undefined)?.count ?? 0);
    const totalPages = Math.max(1, Math.ceil(total / input.limit));
    const safePage = Math.min(Math.max(input.page, 1), totalPages);
    const offset = (safePage - 1) * input.limit;

    const rows = await baseQuery
      .clone()
      .select(
        'al.*',
        'actor.employee_id as actor_employee_id',
        'actor.first_name as actor_first_name',
        'actor.last_name as actor_last_name',
        'actor.profile_image_url as actor_profile_image_url',
        'actor.role as actor_role',
        'target.employee_id as target_employee_id',
        'target.first_name as target_first_name',
        'target.last_name as target_last_name',
        'target.profile_image_url as target_profile_image_url',
        'target.role as target_role',
      )
      .orderBy('al.created_at', 'desc')
      .limit(input.limit)
      .offset(offset);

    const items = (rows as any[]).map((row) => ({
      id: row.id,
      activity_type: row.activity_type,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      created_at: row.created_at,
      actor: row.actor_user_id
        ? {
            id: row.actor_user_id,
            employee_id: row.actor_employee_id ?? null,
            full_name: `${row.actor_first_name ?? ''} ${row.actor_last_name ?? ''}`.trim(),
            role: row.actor_role ?? null,
            profile_image_url: row.actor_profile_image_url ?? null,
          }
        : null,
      target: row.target_user_id
        ? {
            id: row.target_user_id,
            employee_id: row.target_employee_id ?? null,
            full_name: `${row.target_first_name ?? ''} ${row.target_last_name ?? ''}`.trim(),
            role: row.target_role ?? null,
            profile_image_url: row.target_profile_image_url ?? null,
          }
        : null,
      metadata: row.metadata ?? null,
    }));

    return buildPaginatedResponse(safePage, input.limit, total, items);
  }
}
