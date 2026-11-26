import { WfhRequest } from '../models/WfhRequest';
import { formatDateLocal } from './date.utils';

/** Date-range overlap used by leave/WFH apply and attendance lookups. */
export function applyDateRangeOverlapFilter(
  qb: any,
  startDate: string,
  endDate: string,
  startCol = 'start_date',
  endCol = 'end_date',
) {
  qb.whereBetween(startCol, [startDate, endDate])
    .orWhereBetween(endCol, [startDate, endDate])
    .orWhere((inner: any) => inner.where(startCol, '<=', startDate).where(endCol, '>=', endDate));
}

export async function userHasApprovedWfhOnDate(
  orgId: string,
  userId: string,
  dateStr: string,
): Promise<boolean> {
  const row = await WfhRequest.query()
    .where('org_id', orgId)
    .where('user_id', userId)
    .where('status', 'APPROVED')
    .where('start_date', '<=', dateStr)
    .where('end_date', '>=', dateStr)
    .first();
  return Boolean(row);
}

export async function loadApprovedWfhDatesInRange(
  orgId: string,
  userId: string,
  startDate: string,
  endDate: string,
): Promise<Set<string>> {
  const rows = await WfhRequest.query()
    .where('org_id', orgId)
    .where('user_id', userId)
    .where('status', 'APPROVED')
    .where((qb) => {
      applyDateRangeOverlapFilter(qb, startDate, endDate);
    });

  const dates = new Set<string>();
  for (const row of rows) {
    const start = new Date(row.start_date);
    const end = new Date(row.end_date);
    const cursor = new Date(start);
    while (cursor <= end) {
      const key = formatDateLocal(cursor);
      if (key >= startDate && key <= endDate) {
        dates.add(key);
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  return dates;
}
