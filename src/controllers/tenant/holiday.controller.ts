import type { Request, Response } from 'express';
import type { PartialModelObject } from 'objection';

import { Holiday } from '../../models/Holiday';
import { User } from '../../models/User';
import { UserHolidayOverride } from '../../models/UserHolidayOverride';
import { getManagedDepartmentIds } from '../../utils/department-manager.utils';
import {
  createHolidaysSchema,
  deleteHolidayParamsSchema,
  upsertUserHolidaysSchema,
  userHolidayParamsSchema,
} from '../../validators';

const toIsoDate = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string') return value.includes('T') ? value.slice(0, 10) : value;
  return '';
};

const addOneDay = (date: string): string => {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
};

const expandRangeDates = (fromDate: string, toDate: string): string[] => {
  const dates: string[] = [];
  for (let cursor = fromDate; cursor <= toDate; cursor = addOneDay(cursor)) {
    dates.push(cursor);
  }
  return dates;
};

async function resolveHolidayTargetUser(
  org_id: string,
  actorUserId: string,
  actorRole: string,
  targetUserId: string,
): Promise<{ user: User | null; isForbidden: boolean }> {
  const targetUser = await User.query().where('org_id', org_id).where('id', targetUserId).first();
  if (!targetUser) {
    return { user: null, isForbidden: false };
  }

  if (actorRole !== 'manager') {
    return { user: targetUser, isForbidden: false };
  }

  const managedDepartmentIds = await getManagedDepartmentIds(org_id, actorUserId);
  const canManage =
    targetUser.role === 'employee' &&
    !!targetUser.department_id &&
    managedDepartmentIds.includes(targetUser.department_id);

  if (!canManage) {
    return { user: null, isForbidden: true };
  }

  return { user: targetUser, isForbidden: false };
}

export class HolidayController {
  static async list(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Org-wide holidays: same rows payslip / attendance use (fetchOrgHolidayDateSet is org_id only).
    // Do not filter by admin_id or another admin's holidays stay invisible in this API.
    const rows = await Holiday.query()
      .where('org_id', req.user.org_id)
      .orderBy('title', 'asc')
      .orderBy('date', 'asc')
      .orderBy('created_at', 'asc');

    const normalized = rows.map((row) => ({
      id: row.id,
      title: row.title,
      date: toIsoDate(row.date),
    }));

    const items: Array<{
      id: string;
      holiday_ids: string[];
      from_date: string;
      to_date: string;
      title: string;
    }> = [];

    for (const row of normalized) {
      const last = items[items.length - 1];
      if (last && last.title === row.title && addOneDay(last.to_date) === row.date) {
        last.to_date = row.date;
        last.holiday_ids.push(row.id);
      } else {
        items.push({
          id: row.id,
          holiday_ids: [row.id],
          from_date: row.date,
          to_date: row.date,
          title: row.title,
        });
      }
    }

    return res.json({ items });
  }

  static async listForUser(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsedParams = userHolidayParamsSchema.safeParse(req.params);
    if (!parsedParams.success) {
      return res.status(400).json({
        message: 'Invalid request params',
        errors: parsedParams.error.flatten().fieldErrors,
      });
    }

    const org_id = req.user.org_id;
    const { userId } = parsedParams.data;
    const { user, isForbidden } = await resolveHolidayTargetUser(
      org_id,
      req.user.id,
      req.user.role,
      userId,
    );

    if (isForbidden) {
      return res.status(403).json({ message: 'You are not allowed to manage this user' });
    }
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const [rows, overrides] = await Promise.all([
      Holiday.query()
        .where('org_id', org_id)
        .orderBy('title', 'asc')
        .orderBy('date', 'asc')
        .orderBy('created_at', 'asc'),
      UserHolidayOverride.query()
        .where('org_id', org_id)
        .where('user_id', userId)
        .select('holiday_id', 'enabled'),
    ]);

    const enabledByHolidayId = new Map<string, boolean>();
    for (const row of overrides as { holiday_id?: string; enabled?: boolean }[]) {
      if (!row.holiday_id) continue;
      enabledByHolidayId.set(String(row.holiday_id), row.enabled !== false);
    }

    const normalized = rows.map((row) => ({
      id: row.id,
      title: row.title,
      date: toIsoDate(row.date),
      enabled: enabledByHolidayId.has(row.id) ? Boolean(enabledByHolidayId.get(row.id)) : true,
    }));

    const items: Array<{
      id: string;
      holiday_ids: string[];
      from_date: string;
      to_date: string;
      title: string;
      dates: Array<{ holiday_id: string; date: string; enabled: boolean }>;
    }> = [];

    for (const row of normalized) {
      const last = items[items.length - 1];
      if (last && last.title === row.title && addOneDay(last.to_date) === row.date) {
        last.to_date = row.date;
        last.holiday_ids.push(row.id);
        last.dates.push({ holiday_id: row.id, date: row.date, enabled: row.enabled });
      } else {
        items.push({
          id: row.id,
          holiday_ids: [row.id],
          from_date: row.date,
          to_date: row.date,
          title: row.title,
          dates: [{ holiday_id: row.id, date: row.date, enabled: row.enabled }],
        });
      }
    }

    return res.json({ items });
  }

  static async upsertForUser(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsedParams = userHolidayParamsSchema.safeParse(req.params);
    if (!parsedParams.success) {
      return res.status(400).json({
        message: 'Invalid request params',
        errors: parsedParams.error.flatten().fieldErrors,
      });
    }

    const parsedBody = upsertUserHolidaysSchema.safeParse(req.body);
    if (!parsedBody.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsedBody.error.flatten().fieldErrors,
      });
    }

    const org_id = req.user.org_id;
    const { userId } = parsedParams.data;
    const { user, isForbidden } = await resolveHolidayTargetUser(
      org_id,
      req.user.id,
      req.user.role,
      userId,
    );

    if (isForbidden) {
      return res.status(403).json({ message: 'You are not allowed to manage this user' });
    }
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const holidayIds = [...new Set(parsedBody.data.items.map((item) => item.holiday_id))];
    const holidays = await Holiday.query()
      .where('org_id', org_id)
      .whereIn('id', holidayIds)
      .select('id');

    if (holidays.length !== holidayIds.length) {
      return res.status(400).json({
        message: 'One or more holiday_id values are invalid for this organization',
      });
    }

    const latestByHolidayId = new Map<string, boolean>();
    for (const item of parsedBody.data.items) {
      latestByHolidayId.set(item.holiday_id, item.enabled);
    }

    const payloads: PartialModelObject<UserHolidayOverride>[] = [];
    for (const [holiday_id, enabled] of latestByHolidayId.entries()) {
      payloads.push({
        org_id,
        user_id: userId,
        holiday_id,
        enabled,
      });
    }

    await UserHolidayOverride.transaction(async (trx) => {
      for (const payload of payloads) {
        const existing = await UserHolidayOverride.query(trx)
          .where('user_id', userId)
          .where('holiday_id', payload.holiday_id as string)
          .first();

        if (existing) {
          await UserHolidayOverride.query(trx)
            .findById(existing.id)
            .patch({
              enabled: payload.enabled as boolean,
              updated_at: new Date(),
            });
        } else {
          await UserHolidayOverride.query(trx).insert(payload);
        }
      }
    });

    return res.json({
      message: 'User holiday overrides updated successfully',
      updated_count: payloads.length,
    });
  }

  static async create(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = createHolidaysSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const org_id = req.user.org_id;
    const admin_id = req.user.id;
    const invalidRange = parsed.data.items.find((item) => item.to_date < item.from_date);
    if (invalidRange) {
      return res.status(400).json({ message: 'to_date cannot be before from_date' });
    }

    const expanded = parsed.data.items.flatMap((item) =>
      expandRangeDates(item.from_date, item.to_date).map((date) => ({
        date,
        title: item.title.trim(),
      })),
    );

    const uniqueByDate = Array.from(new Map(expanded.map((h) => [h.date, h])).values());
    if (uniqueByDate.length !== expanded.length) {
      return res.status(400).json({ message: 'Overlapping date ranges are not allowed' });
    }

    const dates = uniqueByDate.map((h) => h.date);

    const existing = await Holiday.query()
      .where('org_id', org_id)
      .whereIn('date', dates)
      .select('id', 'date', 'title');

    if (existing.length > 0) {
      return res.status(409).json({
        message: 'One or more selected dates already have holidays',
        existing,
      });
    }

    const created = await Holiday.query().insertAndFetch(
      uniqueByDate.map((holiday) => ({
        org_id,
        admin_id,
        date: holiday.date,
        title: holiday.title,
      })),
    );

    return res.status(201).json({
      message: 'Holidays created successfully',
      count: Array.isArray(created) ? created.length : 1,
    });
  }

  static async delete(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = deleteHolidayParamsSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request params',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { id } = parsed.data;
    const row = await Holiday.query().where('id', id).where('org_id', req.user.org_id).first();

    if (!row) {
      return res.status(404).json({ message: 'Holiday not found' });
    }

    const allWithSameTitle = await Holiday.query()
      .where('org_id', req.user.org_id)
      .where('title', row.title)
      .orderBy('date', 'asc')
      .select('id', 'date');

    const normalized = allWithSameTitle.map((item) => ({
      id: item.id,
      date: toIsoDate(item.date),
    }));

    const pivotIndex = normalized.findIndex((item) => item.id === id);
    if (pivotIndex === -1) {
      return res.status(404).json({ message: 'Holiday not found' });
    }

    let start = pivotIndex;
    while (start > 0 && addOneDay(normalized[start - 1].date) === normalized[start].date) {
      start -= 1;
    }

    let end = pivotIndex;
    while (
      end < normalized.length - 1 &&
      addOneDay(normalized[end].date) === normalized[end + 1].date
    ) {
      end += 1;
    }

    const idsToDelete = normalized.slice(start, end + 1).map((item) => item.id);
    await Holiday.query().whereIn('id', idsToDelete).delete();

    return res.json({ message: 'Holiday deleted successfully', deleted_count: idsToDelete.length });
  }
}
