import { logger } from '../config/logger';
import {
  HALF_DAY_NO_PUNCH_CANCEL_REASON,
  HALF_DAY_NO_PUNCH_PENALTY_LOP_DAYS,
} from '../constants/half-day-no-punch.constants';
import { AttendanceHalfDayNoPunchPenalty } from '../models/AttendanceHalfDayNoPunchPenalty';
import { AttendanceLog } from '../models/AttendanceLog';
import { LeaveRequest } from '../models/LeaveRequest';
import { User } from '../models/User';
import { ACTIVITY_ENTITY_TYPES, ACTIVITY_TYPES, ActivityLogService } from './activity-log.service';
import {
  fetchEffectiveHolidayDateSetsForUsers,
  fetchOrgHolidayDateSet,
  isUserAttendanceScheduledDay,
  resolveEffectiveAttendanceSchedule,
} from '../utils/attendance-schedule.utils';
import { addCalendarDays, getTodayDate } from '../utils/date.utils';
import { fetchPrimaryManagedDepartmentScheduleByManagerIds } from '../utils/department-manager.utils';

const ONE_MINUTE_MS = 60 * 1000;

export const processHalfDayNoPunchPenaltiesForDate = async (
  targetDate: string,
): Promise<number> => {
  const halfDayLeaves = await LeaveRequest.query()
    .alias('lr')
    .where('lr.status', 'APPROVED')
    .whereIn('lr.day_session', ['FIRST_HALF', 'SECOND_HALF'])
    .where('lr.start_date', '<=', targetDate)
    .where('lr.end_date', '>=', targetDate)
    .select(
      'lr.id',
      'lr.org_id',
      'lr.user_id',
      'lr.leave_type_id',
      'lr.start_date',
      'lr.end_date',
      'lr.day_session',
    );

  if (halfDayLeaves.length === 0) {
    return 0;
  }

  const userIds = Array.from(new Set(halfDayLeaves.map((row) => String((row as any).user_id))));
  const orgIds = Array.from(new Set(halfDayLeaves.map((row) => String((row as any).org_id))));
  const emptyUserId = '00000000-0000-0000-0000-000000000000';

  const [existingPenalties, punchRows, userRows] = await Promise.all([
    AttendanceHalfDayNoPunchPenalty.query()
      .where('penalty_date', targetDate)
      .whereIn('user_id', userIds.length > 0 ? userIds : [emptyUserId])
      .select('user_id', 'org_id'),
    AttendanceLog.query()
      .where('date', targetDate)
      .whereIn('user_id', userIds.length > 0 ? userIds : [emptyUserId])
      .whereNotNull('clock_in_time')
      .select('user_id', 'org_id'),
    User.query()
      .alias('u')
      .leftJoin('departments as d', 'd.id', 'u.department_id')
      .whereIn('u.id', userIds.length > 0 ? userIds : [emptyUserId])
      .select(
        'u.id',
        'u.org_id',
        'u.role',
        'u.department_id',
        'd.working_days as department_working_days',
      ),
  ]);

  const penaltyKeySet = new Set(
    (existingPenalties as Array<{ user_id?: string; org_id?: string }>).map(
      (row) => `${row.org_id}|${row.user_id}`,
    ),
  );
  const punchKeySet = new Set(
    (punchRows as Array<{ user_id?: string; org_id?: string }>).map(
      (row) => `${row.org_id}|${row.user_id}`,
    ),
  );
  const userById = new Map((userRows as any[]).map((row) => [String(row.id), row]));

  const holidaySetByOrg = new Map<string, Set<string>>();
  const holidaySetByOrgUser = new Map<string, Map<string, Set<string>>>();
  for (const orgId of orgIds) {
    holidaySetByOrg.set(orgId, await fetchOrgHolidayDateSet(orgId, targetDate, targetDate));
    const orgUserIds = (userRows as any[])
      .filter((row) => String(row.org_id) === orgId)
      .map((row) => String(row.id));
    holidaySetByOrgUser.set(
      orgId,
      await fetchEffectiveHolidayDateSetsForUsers(orgId, orgUserIds, targetDate, targetDate),
    );
  }

  const managedScheduleByOrgManager = new Map<
    string,
    Awaited<ReturnType<typeof fetchPrimaryManagedDepartmentScheduleByManagerIds>>
  >();
  for (const orgId of orgIds) {
    const managerIds = (userRows as any[])
      .filter((row) => row.org_id === orgId && row.role === 'manager')
      .map((row) => String(row.id));
    if (managerIds.length > 0) {
      managedScheduleByOrgManager.set(
        orgId,
        await fetchPrimaryManagedDepartmentScheduleByManagerIds(orgId, managerIds),
      );
    }
  }

  let processedCount = 0;

  for (const leaveRow of halfDayLeaves as any[]) {
    const orgId = String(leaveRow.org_id);
    const userId = String(leaveRow.user_id);
    const penaltyKey = `${orgId}|${userId}`;

    if (penaltyKeySet.has(penaltyKey) || punchKeySet.has(penaltyKey)) {
      continue;
    }

    const userRow = userById.get(userId);
    if (!userRow || String(userRow.org_id) !== orgId) {
      continue;
    }

    const holidaySet =
      holidaySetByOrgUser.get(orgId)?.get(userId) ??
      holidaySetByOrg.get(orgId) ??
      new Set<string>();
    const managedScheduleByManagerId =
      managedScheduleByOrgManager.get(orgId) ??
      new Map<string, { departmentId: string; workingDays: string[] | null }>();

    const schedule = resolveEffectiveAttendanceSchedule(
      {
        role: userRow.role,
        department_id: userRow.department_id ?? null,
        department_working_days: userRow.department_working_days,
      },
      userRow.role === 'manager' ? managedScheduleByManagerId.get(userId) : undefined,
    );

    const scheduled = isUserAttendanceScheduledDay({
      dateStr: targetDate,
      holidaySet,
      departmentId: schedule.departmentId,
      workingDays: schedule.workingDays,
    });
    if (!scheduled) {
      continue;
    }

    const now = new Date();

    await LeaveRequest.query().findById(leaveRow.id).patch({
      status: 'CANCELLED',
      cancelled_at: now,
      cancelled_by: null,
      updated_at: now,
      updated_by: null,
    });

    await AttendanceHalfDayNoPunchPenalty.query().insert({
      org_id: orgId,
      user_id: userId,
      penalty_date: targetDate,
      original_leave_request_id: leaveRow.id,
      supplemental_leave_request_id: null,
      lop_days: HALF_DAY_NO_PUNCH_PENALTY_LOP_DAYS,
      processed_at: now.toISOString(),
    });

    await ActivityLogService.recordActivitySafely({
      org_id: orgId,
      actor_user_id: null,
      target_user_id: userId,
      entity_type: ACTIVITY_ENTITY_TYPES.LEAVE_REQUEST,
      entity_id: leaveRow.id,
      activity_type: ACTIVITY_TYPES.LEAVE_CANCELLED,
      metadata: {
        status: 'CANCELLED',
        reason: HALF_DAY_NO_PUNCH_CANCEL_REASON,
        penalty_date: targetDate,
        lop_days: HALF_DAY_NO_PUNCH_PENALTY_LOP_DAYS,
        leave_type_id: leaveRow.leave_type_id,
        day_session: leaveRow.day_session,
      },
    });

    penaltyKeySet.add(penaltyKey);
    processedCount += 1;
  }

  return processedCount;
};

const processYesterdayHalfDayNoPunchPenalties = async (): Promise<void> => {
  const todayStr = getTodayDate();
  const targetDate = addCalendarDays(todayStr, -1);
  const processedCount = await processHalfDayNoPunchPenaltiesForDate(targetDate);

  if (processedCount > 0) {
    logger.info(
      { targetDate, processed_count: processedCount },
      'Half-day no-punch penalty scheduler processed records',
    );
  }
};

export function startHalfDayNoPunchPenaltyScheduler(): void {
  const run = async () => {
    try {
      await processYesterdayHalfDayNoPunchPenalties();
    } catch (error) {
      logger.error({ err: error }, 'Half-day no-punch penalty scheduler run failed');
    }
  };

  void run();
  setInterval(() => {
    void run();
  }, ONE_MINUTE_MS);
}
