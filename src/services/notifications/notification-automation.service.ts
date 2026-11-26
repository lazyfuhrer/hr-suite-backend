import { LeaveRequest } from '../../models/LeaveRequest';
import { NotificationAutomationLog } from '../../models/NotificationAutomationLog';
import { User } from '../../models/User';
import { AttendanceLog } from '../../models/AttendanceLog';
import { AttendanceBreak } from '../../models/AttendanceBreak';
import { Organization } from '../../models/Organization';
import { DepartmentManager } from '../../models/DepartmentManager';
import { UserProfile } from '../../models/UserProfile';
import { Holiday } from '../../models/Holiday';
import { UserDeviceToken } from '../../models/UserDeviceToken';
import { ATTENDANCE_ACTIVE_EMPLOYEE_STATUSES } from '../../constants/user-status';
import { ORG_USER_ROLES } from '../../constants/user-roles';
import { getNowInIST, parseTimeToMinutes } from '../../utils/date.utils';
import {
  fetchEffectiveHolidayDateSetsForUsers,
  fetchOrgHolidayDateSet,
  isUserAttendanceScheduledDay,
} from '../../utils/attendance-schedule.utils';
import { logger } from '../../config/logger';
import { dispatchNotificationEvent } from './notification-dispatcher.service';
import { getNotificationSettings } from './notification-settings.service';

const ONE_MINUTE_MS = 60 * 1000;

type UserShiftRow = {
  id: string;
  first_name: string;
  last_name: string;
  manager_id: string | null;
  department_id: string | null;
  role: string;
  user_shift_start_time: string | null;
  user_shift_end_time: string | null;
  user_break_start_time: string | null;
  user_break_end_time: string | null;
  user_break_duration_mins: number | null;
  dept_shift_start_time: string | null;
  dept_shift_end_time: string | null;
  dept_break_start_time: string | null;
  dept_break_end_time: string | null;
  dept_break_duration_mins: number | null;
  department_working_days?: string[] | null;
  work_mode: string | null;
};

/** First managed department (by department id) with a default shift, per manager, for attendance schedule fallback. */
type ManagedDeptSchedule = {
  departmentId: string;
  workingDays: string[] | null;
  shiftStart: string | null;
  shiftEnd: string | null;
  breakStart: string | null;
  breakEnd: string | null;
  breakDurationMins: number | null;
};

const MINUTES_IN_DAY = 24 * 60;

function modDayMinutes(value: number): number {
  // Normalize to [0, 1439] even if value is negative/overflow.
  return ((value % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
}

function isLocationRequestEligibleWorkMode(workMode: string | null | undefined): boolean {
  const mode = workMode?.toUpperCase();
  return mode === 'HYBRID' || mode === 'REMOTE';
}

function isWithinMinuteWindow(nowMinutes: number, targetMinutes: number, windowMins = 1): boolean {
  const now = modDayMinutes(nowMinutes);
  const target = modDayMinutes(targetMinutes);
  const forward = (now - target + MINUTES_IN_DAY) % MINUTES_IN_DAY;
  const distance = Math.min(forward, MINUTES_IN_DAY - forward);
  return distance <= windowMins;
}

function minutesToTimeHHmm(minutes: number): string {
  const normalized = modDayMinutes(minutes);
  const hours = Math.floor(normalized / 60);
  const mins = normalized % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

function generateLocationPromptSlotMinutes(
  shiftStartMins: number,
  shiftEndMins: number,
  intervalHours: number,
): number[] {
  const intervalMins = intervalHours * 60;
  if (intervalMins <= 0) {
    return [];
  }

  const crossesMidnight = shiftEndMins <= shiftStartMins;
  const shiftDurationMins = crossesMidnight
    ? shiftEndMins + MINUTES_IN_DAY - shiftStartMins
    : shiftEndMins - shiftStartMins;

  const slots: number[] = [];
  for (let offset = 0; offset <= shiftDurationMins; offset += intervalMins) {
    slots.push(modDayMinutes(shiftStartMins + offset));
  }
  return slots;
}

const buildEventKey = (
  orgId: string,
  subjectUserId: string,
  ruleKey: string,
  dateKey: string,
  scheduleKey?: string | null,
): string =>
  `${orgId}:${subjectUserId}:${ruleKey}:${dateKey}${scheduleKey ? `:${scheduleKey}` : ''}`;

async function shouldSkipBecauseAlreadySent(args: {
  eventKey: string;
  subjectUserId: string;
}): Promise<boolean> {
  const row = await NotificationAutomationLog.query()
    .where('event_key', args.eventKey)
    .whereIn('status', ['SENT', 'READ', 'DISMISSED'])
    .where('success_count', '>', 0)
    .first();

  if (!row) return false;

  // Token refresh can happen after a send attempt. We ONLY allow a same-day retry
  // if the prior send had at least one failure (i.e. partial delivery / device churn).
  // If the prior send was a clean success, re-registering should NOT cause duplicates.
  const tokenRow = await UserDeviceToken.query()
    .where('user_id', args.subjectUserId)
    .where('enabled', true)
    .select('last_seen_at')
    .first();

  const sentAtMs = row.sent_at ? new Date(row.sent_at).getTime() : NaN;
  const lastSeenMs = tokenRow?.last_seen_at ? new Date(tokenRow.last_seen_at).getTime() : NaN;

  if (
    Number.isFinite(sentAtMs) &&
    Number.isFinite(lastSeenMs) &&
    lastSeenMs > sentAtMs &&
    row.failure_count > 0
  ) {
    return false;
  }

  return true;
}

async function createPendingLog(args: {
  orgId: string;
  subjectUserId: string;
  ruleKey: string;
  eventKey: string;
  meta: Record<string, unknown>;
}): Promise<NotificationAutomationLog> {
  // Idempotent pending creation: event_key is unique, so we must avoid crashing on duplicates.
  await NotificationAutomationLog.query()
    .insert({
      org_id: args.orgId,
      subject_user_id: args.subjectUserId,
      rule_key: args.ruleKey,
      event_key: args.eventKey,
      status: 'PENDING',
      trigger_time: new Date().toISOString(),
      meta: args.meta,
    })
    .onConflict('event_key')
    .ignore();

  const row = await NotificationAutomationLog.query().findOne({ event_key: args.eventKey });
  if (!row) {
    throw new Error('Failed to create or load pending automation log');
  }
  return row;
}

async function markLogSent(
  id: string,
  audienceCount: number,
  successCount: number,
  failureCount: number,
): Promise<void> {
  await NotificationAutomationLog.query().patchAndFetchById(id, {
    status: 'SENT',
    sent_at: new Date().toISOString(),
    audience_count: audienceCount,
    success_count: successCount,
    failure_count: failureCount,
  });
}

function fullName(user: { first_name: string; last_name: string }): string {
  return `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim();
}

async function processOrg(org: { id: string; name: string }): Promise<void> {
  const settings = await getNotificationSettings(org.id);
  const nowIst = getNowInIST();
  const nowMinutes = nowIst.getUTCHours() * 60 + nowIst.getUTCMinutes();
  const dateStr = `${nowIst.getUTCFullYear()}-${String(nowIst.getUTCMonth() + 1).padStart(2, '0')}-${String(
    nowIst.getUTCDate(),
  ).padStart(2, '0')}`;

  const holidaySet = await fetchOrgHolidayDateSet(org.id, dateStr, dateStr);

  const managedDeptScheduleByManagerId = new Map<string, ManagedDeptSchedule>();
  const managedScheduleRows = await DepartmentManager.query()
    .alias('dm')
    .innerJoin('departments as d', 'd.id', 'dm.department_id')
    .innerJoin('work_shifts as ws', 'ws.id', 'd.default_shift_id')
    .where('d.org_id', org.id)
    .whereNull('d.deleted_at')
    .select(
      'dm.manager_id',
      'd.id as managed_department_id',
      'd.working_days as managed_working_days',
      'ws.start_time as managed_shift_start',
      'ws.end_time as managed_shift_end',
      'ws.break_start_time as managed_break_start',
      'ws.break_end_time as managed_break_end',
      'ws.break_duration_mins as managed_break_duration_mins',
    )
    .orderBy('dm.manager_id')
    .orderBy('d.id');

  for (const row of managedScheduleRows as any[]) {
    const managerId = String(row.manager_id);
    // If a user manages multiple departments, use the first by department id that has a default shift.
    if (managedDeptScheduleByManagerId.has(managerId)) {
      continue;
    }
    const wdRaw = row.managed_working_days;
    managedDeptScheduleByManagerId.set(managerId, {
      departmentId: String(row.managed_department_id),
      workingDays: Array.isArray(wdRaw) ? wdRaw : null,
      shiftStart: row.managed_shift_start ?? null,
      shiftEnd: row.managed_shift_end ?? null,
      breakStart: row.managed_break_start ?? null,
      breakEnd: row.managed_break_end ?? null,
      breakDurationMins:
        row.managed_break_duration_mins != null ? Number(row.managed_break_duration_mins) : null,
    });
  }

  const users = (await User.query()
    .alias('u')
    .leftJoin('departments as d', 'd.id', 'u.department_id')
    .leftJoin('work_shifts as ws_user', 'ws_user.id', 'u.shift_id')
    .leftJoin('work_shifts as ws_dept', 'ws_dept.id', 'd.default_shift_id')
    .leftJoin('employee_employment_details as eed', 'eed.user_id', 'u.id')
    .where('u.org_id', org.id)
    .whereIn('u.role', ORG_USER_ROLES)
    .whereIn('u.status', ATTENDANCE_ACTIVE_EMPLOYEE_STATUSES as readonly string[])
    .whereNull('u.deleted_at')
    .select(
      'u.id',
      'u.first_name',
      'u.last_name',
      'u.manager_id',
      'u.department_id',
      'u.role',
      'ws_user.start_time as user_shift_start_time',
      'ws_user.end_time as user_shift_end_time',
      'ws_user.break_start_time as user_break_start_time',
      'ws_user.break_end_time as user_break_end_time',
      'ws_user.break_duration_mins as user_break_duration_mins',
      'ws_dept.start_time as dept_shift_start_time',
      'ws_dept.end_time as dept_shift_end_time',
      'ws_dept.break_start_time as dept_break_start_time',
      'ws_dept.break_end_time as dept_break_end_time',
      'ws_dept.break_duration_mins as dept_break_duration_mins',
      'd.working_days as department_working_days',
      'eed.work_mode as work_mode',
    )) as unknown as UserShiftRow[];

  if (users.length === 0) {
    return;
  }

  const userIds = users.map((u) => u.id);
  const holidaySetByUserId = await fetchEffectiveHolidayDateSetsForUsers(
    org.id,
    userIds,
    dateStr,
    dateStr,
  );
  const departmentIds = Array.from(
    new Set(users.map((u) => u.department_id).filter((id): id is string => typeof id === 'string')),
  );

  const [logs, approvedLeaves, hrs, deptManagers] = await Promise.all([
    AttendanceLog.query()
      .where('org_id', org.id)
      .where('date', dateStr)
      .whereIn('user_id', userIds)
      .select('id', 'user_id', 'clock_in_time', 'clock_out_time'),
    LeaveRequest.query()
      .where('org_id', org.id)
      .where('status', 'APPROVED')
      .where('start_date', '<=', dateStr)
      .where('end_date', '>=', dateStr)
      .whereIn('user_id', userIds)
      .select('user_id'),
    User.query()
      .where('org_id', org.id)
      .where('role', 'hr')
      .whereIn('status', ATTENDANCE_ACTIVE_EMPLOYEE_STATUSES as readonly string[])
      .whereNull('deleted_at')
      .select('id'),
    departmentIds.length > 0
      ? DepartmentManager.query()
          .whereIn('department_id', departmentIds)
          .select('department_id', 'manager_id')
      : [],
  ]);

  const logByUserId = new Map<string, any>();
  const logIdList: string[] = [];
  for (const log of logs as any[]) {
    logByUserId.set(log.user_id, log);
    logIdList.push(String(log.id));
  }

  const breaks = logIdList.length
    ? await AttendanceBreak.query()
        .whereIn('attendance_log_id', logIdList)
        .select('attendance_log_id', 'start_time', 'end_time')
    : [];
  const openBreakByLogId = new Map<string, { start_time: string; end_time?: string | null }>();
  for (const brk of breaks as any[]) {
    if (!brk.end_time) {
      openBreakByLogId.set(String(brk.attendance_log_id), brk);
    }
  }

  const leaveUserSet = new Set((approvedLeaves as any[]).map((l) => l.user_id));
  const hrIds = (hrs as any[]).map((h) => h.id);
  const deptManagerMap = new Map<string, string[]>();
  for (const row of deptManagers as any[]) {
    const existing = deptManagerMap.get(row.department_id) ?? [];
    existing.push(row.manager_id);
    deptManagerMap.set(row.department_id, existing);
  }

  const SELF_ONLY_RULE_KEYS = new Set([
    'before_shift_start',
    'after_shift_start_no_checkin',
    'before_shift_end',
    'after_shift_end_no_checkout',
    'before_break_start',
    'before_break_end',
    'break_exceeded',
    'location_request',
  ]);

  const sendRuleNotification = async (input: {
    subject: UserShiftRow;
    ruleKey: string;
    title: string;
    body: string;
    meta?: Record<string, unknown>;
    audienceIds?: string[];
    scheduleKey?: string | null;
    data?: Record<string, string>;
  }) => {
    const subject = input.subject;
    const defaultAudienceIds = (() => {
      if (SELF_ONLY_RULE_KEYS.has(input.ruleKey)) return [subject.id];
      const managerIds = [
        ...(subject.manager_id ? [subject.manager_id] : []),
        ...((subject.department_id && deptManagerMap.get(subject.department_id)) ?? []),
      ];
      return [subject.id, ...hrIds, ...managerIds];
    })();

    const audienceIds = Array.from(new Set(input.audienceIds ?? defaultAudienceIds));
    if (audienceIds.length === 0) {
      return;
    }

    const eventKey = buildEventKey(org.id, subject.id, input.ruleKey, dateStr, input.scheduleKey);
    if (await shouldSkipBecauseAlreadySent({ eventKey, subjectUserId: subject.id })) {
      return;
    }

    const pending = await createPendingLog({
      orgId: org.id,
      subjectUserId: subject.id,
      ruleKey: input.ruleKey,
      eventKey,
      meta: {
        date: dateStr,
        audience_ids: audienceIds,
        ...(input.meta ?? {}),
      },
    });

    const result = await dispatchNotificationEvent({
      event: `automation.${input.ruleKey}`,
      scope: 'user',
      orgId: org.id,
      userIds: audienceIds,
      title: input.title,
      body: input.body,
      data: {
        subjectUserId: subject.id,
        orgId: org.id,
        ...(input.data ?? {}),
      },
    });

    const attemptedCount = result.successCount + result.failureCount;
    if (attemptedCount === 0) {
      // No enabled tokens resolved for this audience; don't persist de-dup log.
      await NotificationAutomationLog.query().deleteById(pending.id);
      return;
    }

    if (result.successCount === 0) {
      // Nothing was delivered successfully; allow future retries.
      await NotificationAutomationLog.query().deleteById(pending.id);
      return;
    }

    await markLogSent(pending.id, audienceIds.length, result.successCount, result.failureCount);
  };

  let sampledUsers = 0;
  for (const user of users) {
    if (leaveUserSet.has(user.id)) {
      continue;
    }

    let shiftStart = user.user_shift_start_time ?? user.dept_shift_start_time ?? null;
    let shiftEnd = user.user_shift_end_time ?? user.dept_shift_end_time ?? null;
    let breakStart = user.user_break_start_time ?? user.dept_break_start_time ?? null;
    let breakEnd = user.user_break_end_time ?? user.dept_break_end_time ?? null;
    let breakDurationMins = user.user_break_duration_mins ?? user.dept_break_duration_mins ?? 0;

    let scheduleDepartmentId: string | null = user.department_id;
    const homeWorkingDaysRaw = user.department_working_days;
    let scheduleWorkingDays = Array.isArray(homeWorkingDaysRaw) ? homeWorkingDaysRaw : null;

    if (!shiftStart) {
      const managed = managedDeptScheduleByManagerId.get(user.id);
      if (managed) {
        shiftStart = managed.shiftStart;
        shiftEnd = managed.shiftEnd;
        breakStart = managed.breakStart;
        breakEnd = managed.breakEnd;
        breakDurationMins = managed.breakDurationMins ?? 0;
        scheduleDepartmentId = managed.departmentId;
        scheduleWorkingDays = managed.workingDays;
      }
    }

    if (
      !isUserAttendanceScheduledDay({
        dateStr,
        holidaySet: holidaySetByUserId.get(String(user.id)) ?? holidaySet,
        departmentId: scheduleDepartmentId,
        workingDays: scheduleWorkingDays,
      })
    ) {
      continue;
    }
    const log = logByUserId.get(user.id) as any;
    const hasCheckIn = Boolean(log?.clock_in_time);
    const hasCheckOut = Boolean(log?.clock_out_time);

    const userName = fullName(user);
    const shiftStartMins = parseTimeToMinutes(shiftStart);
    const shiftEndMins = parseTimeToMinutes(shiftEnd);
    const breakStartMins = parseTimeToMinutes(breakStart);
    const breakEndMins = parseTimeToMinutes(breakEnd);
    const openBreak = openBreakByLogId.get(String(log?.id ?? ''));

    const matches = {
      before_shift_start:
        Boolean(settings.enabled_before_shift_start && shiftStart) &&
        isWithinMinuteWindow(nowMinutes, shiftStartMins - settings.before_shift_start_mins, 1),
      after_shift_start_no_checkin:
        Boolean(settings.enabled_after_shift_start_no_checkin && shiftStart && !hasCheckIn) &&
        isWithinMinuteWindow(
          nowMinutes,
          shiftStartMins + settings.after_shift_start_no_checkin_mins,
          1,
        ),
      before_shift_end:
        Boolean(settings.enabled_before_shift_end && shiftEnd && hasCheckIn && !hasCheckOut) &&
        isWithinMinuteWindow(nowMinutes, shiftEndMins - settings.before_shift_end_mins, 1),
      after_shift_end_no_checkout:
        Boolean(
          settings.enabled_after_shift_end_no_checkout && shiftEnd && hasCheckIn && !hasCheckOut,
        ) &&
        isWithinMinuteWindow(
          nowMinutes,
          shiftEndMins + settings.after_shift_end_no_checkout_mins,
          1,
        ),
      before_break_start:
        Boolean(
          settings.enabled_before_break_start &&
          breakStart &&
          !log?.clock_out_time &&
          !openBreak &&
          log?.id,
        ) && isWithinMinuteWindow(nowMinutes, breakStartMins - settings.before_break_start_mins, 1),
      before_break_end:
        Boolean(settings.enabled_before_break_end && breakEnd && openBreak) &&
        isWithinMinuteWindow(nowMinutes, breakEndMins - settings.before_break_end_mins, 1),
      break_exceeded: Boolean(
        settings.enabled_break_exceeded &&
        openBreak &&
        breakDurationMins > 0 &&
        openBreak?.start_time,
      ),
    };
    if (sampledUsers < 3) {
      sampledUsers += 1;
    }

    if (matches.before_shift_start) {
      await sendRuleNotification({
        subject: user,
        ruleKey: 'before_shift_start',
        title: `Your shift starts in ${settings.before_shift_start_mins} minutes ⏰`,
        body: `Hi ${userName}, your shift begins at ${shiftStart}. Please be ready to clock in on time.`,
        scheduleKey: shiftStart,
        meta: { shift_start_time: shiftStart },
        audienceIds: [user.id],
      });
    }

    if (matches.after_shift_start_no_checkin) {
      await sendRuleNotification({
        subject: user,
        ruleKey: 'after_shift_start_no_checkin',
        title: "You haven't clocked in yet ❗",
        body: `Hi ${userName}, you missed your scheduled login at ${shiftStart}. Please clock in immediately or contact your manager.`,
        scheduleKey: shiftStart,
        meta: { shift_start_time: shiftStart },
        audienceIds: [user.id],
      });
    }

    if (matches.before_shift_end) {
      await sendRuleNotification({
        subject: user,
        ruleKey: 'before_shift_end',
        title: `Your shift ends in ${settings.before_shift_end_mins} minutes ⌛`,
        body: `Hi ${userName}, your shift ends at ${shiftEnd}. Please complete pending tasks and prepare to clock out.`,
        scheduleKey: shiftEnd,
        meta: { shift_end_time: shiftEnd },
        audienceIds: [user.id],
      });
    }

    if (matches.after_shift_end_no_checkout) {
      await sendRuleNotification({
        subject: user,
        ruleKey: 'after_shift_end_no_checkout',
        title: `Shift ended ${settings.after_shift_end_no_checkout_mins} minutes ago ⏰`,
        body: `Hi ${userName}, your scheduled shift ended at ${shiftEnd}. If you are continuing with overtime, no action is needed right now. If you have completed work for the day, please remember to clock out to keep your attendance updated.`,
        scheduleKey: shiftEnd,
        meta: { shift_end_time: shiftEnd },
        audienceIds: [user.id],
      });
    }

    if (matches.before_break_start) {
      await sendRuleNotification({
        subject: user,
        ruleKey: 'before_break_start',
        title: `Break starts in ${settings.before_break_start_mins} minutes ☕`,
        body: `Hi ${userName}, your scheduled break begins at ${breakStart}. Please wrap up current tasks.`,
        scheduleKey: breakStart,
        meta: { break_start_time: breakStart },
        audienceIds: [user.id],
      });
    }

    if (matches.before_break_end) {
      await sendRuleNotification({
        subject: user,
        ruleKey: 'before_break_end',
        title: `Break ends in ${settings.before_break_end_mins} minutes 🔔`,
        body: `Hi ${userName}, your break ends at ${breakEnd}. Please be ready to resume work.`,
        scheduleKey: breakEnd,
        meta: { break_end_time: breakEnd },
        audienceIds: [user.id],
      });
    }

    if (matches.break_exceeded && openBreak) {
      const startDate = new Date(openBreak.start_time);
      if (!Number.isNaN(startDate.getTime())) {
        const breakElapsedMinutes = Math.floor((Date.now() - startDate.getTime()) / 60000);
        if (breakElapsedMinutes >= breakDurationMins + settings.break_exceeded_mins) {
          await sendRuleNotification({
            subject: user,
            ruleKey: 'break_exceeded',
            title: `Your break time has been exceeded by ${settings.break_exceeded_mins} minutes ❗`,
            body: `Hi ${userName}, your scheduled break time has now been exceeded by ${settings.break_exceeded_mins} minutes. Please resume work immediately.`,
            scheduleKey: openBreak.start_time ? String(openBreak.start_time).slice(0, 16) : null,
            meta: { break_elapsed_mins: breakElapsedMinutes },
            audienceIds: [user.id],
          });
        }
      }
    }

    if (
      settings.enabled_location_request_notifications &&
      shiftStart &&
      shiftEnd &&
      hasCheckIn &&
      !hasCheckOut &&
      isLocationRequestEligibleWorkMode(user.work_mode)
    ) {
      const locationSlots = generateLocationPromptSlotMinutes(
        shiftStartMins,
        shiftEndMins,
        settings.location_request_interval_hours,
      );
      for (const slotMins of locationSlots) {
        if (!isWithinMinuteWindow(nowMinutes, slotMins, 1)) {
          continue;
        }
        const promptSlotKey = minutesToTimeHHmm(slotMins);
        await sendRuleNotification({
          subject: user,
          ruleKey: 'location_request',
          title: 'Please share your location',
          body: `Hi ${userName}, please submit your current location for today.`,
          scheduleKey: promptSlotKey,
          meta: {
            prompt_slot_key: promptSlotKey,
            shift_start_time: shiftStart,
            shift_end_time: shiftEnd,
            work_mode: user.work_mode,
          },
          audienceIds: [user.id],
          data: {
            action: 'submit_location',
            promptSlotKey,
          },
        });
      }
    }
  }

  const audienceAllIds = users.map((u) => u.id);
  const userById = new Map(users.map((u) => [u.id, u]));

  if (settings.enabled_birthday_notifications || settings.enabled_work_anniversary_notifications) {
    const birthdayRows = settings.enabled_birthday_notifications
      ? await UserProfile.query()
          .alias('up')
          .innerJoin('users as u', 'u.id', 'up.user_id')
          .where('u.org_id', org.id)
          .whereIn('u.role', ORG_USER_ROLES)
          .whereIn('u.status', ATTENDANCE_ACTIVE_EMPLOYEE_STATUSES as readonly string[])
          .whereNull('u.deleted_at')
          .whereRaw("to_char(up.dob, 'MM-DD') = ?", [dateStr.slice(5)])
          .select('u.id as user_id')
      : [];

    for (const row of birthdayRows as any[]) {
      const subject = userById.get(row.user_id);
      if (!subject) continue;
      const recipientIds = settings.enabled_occasion_self_notifications
        ? audienceAllIds
        : audienceAllIds.filter((id) => id !== subject.id);
      await sendRuleNotification({
        subject,
        ruleKey: 'birthday_today',
        title: `Celebrate ${fullName(subject)}'s Birthday today 🎂`,
        body: `Wish ${fullName(subject)} a very happy birthday and make their day special!`,
        audienceIds: recipientIds,
        meta: { occasion_type: 'Birthday' },
      });
    }

    if (settings.enabled_work_anniversary_notifications) {
      const anniversaryRows = await User.query()
        .alias('u')
        .where('u.org_id', org.id)
        .whereIn('u.role', ORG_USER_ROLES)
        .whereIn('u.status', ATTENDANCE_ACTIVE_EMPLOYEE_STATUSES as readonly string[])
        .whereNull('u.deleted_at')
        .whereRaw("to_char(u.date_of_joining::date, 'MM-DD') = ?", [dateStr.slice(5)])
        .whereRaw('u.date_of_joining::date < ?::date', [dateStr])
        .select('u.id as user_id');

      for (const row of anniversaryRows as any[]) {
        const subject = userById.get(row.user_id);
        if (!subject) continue;
        const recipientIds = settings.enabled_occasion_self_notifications
          ? audienceAllIds
          : audienceAllIds.filter((id) => id !== subject.id);
        await sendRuleNotification({
          subject,
          ruleKey: 'work_anniversary_today',
          title: `Celebrate ${fullName(subject)}'s Work Anniversary today 🎉`,
          body: `Join us in celebrating ${fullName(subject)}'s work anniversary today.`,
          audienceIds: recipientIds,
          meta: { occasion_type: 'Work Anniversary' },
        });
      }
    }
  }

  if (settings.enabled_holiday_notifications) {
    const holidays = await Holiday.query()
      .where('org_id', org.id)
      .where('date', dateStr)
      .select('id', 'title');
    for (const holiday of holidays as any[]) {
      for (const subject of users) {
        const effectiveSet = holidaySetByUserId.get(String(subject.id)) ?? holidaySet;
        if (!effectiveSet.has(dateStr)) {
          continue;
        }
        await sendRuleNotification({
          subject,
          ruleKey: `holiday_today_${holiday.id}`,
          title: `Happy ${holiday.title}, ${fullName(subject)}! 🎉`,
          body: `Wishing you a fantastic ${holiday.title} from ${org.name}.`,
          audienceIds: [subject.id],
          meta: { holiday_title: holiday.title },
        });
      }
    }
  }
}

export async function runNotificationAutomationCycle(): Promise<void> {
  const nowIso = new Date().toISOString();
  const orgs = await Organization.query()
    .select('id', 'name')
    .whereNull('deleted_at')
    .where('expires_at', '>', nowIso);
  for (const org of orgs as any[]) {
    try {
      await processOrg({ id: org.id, name: org.name ?? '' });
    } catch (error) {
      logger.error({ err: error, org_id: org.id }, 'Notification automation cycle failed for org');
    }
  }
}

export function startNotificationAutomationScheduler(): void {
  const run = async () => {
    try {
      await runNotificationAutomationCycle();
    } catch (error) {
      logger.error({ err: error }, 'Notification automation scheduler run failed');
    }
  };

  const now = new Date();
  const msUntilNextMinute = ONE_MINUTE_MS - (now.getTime() % ONE_MINUTE_MS || ONE_MINUTE_MS);

  // Align to minute boundary to reduce drift over long uptimes.
  setTimeout(() => {
    void run();
    setInterval(() => {
      void run();
    }, ONE_MINUTE_MS);
  }, msUntilNextMinute);
}
