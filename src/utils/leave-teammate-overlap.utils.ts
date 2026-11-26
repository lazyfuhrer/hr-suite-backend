import { LeaveRequest } from '../models/LeaveRequest';
import { getManagedDepartmentIds } from './department-manager.utils';

export const buildOverlapDepartmentIdsFromRow = (
  row: {
    role?: string | null;
    user_id?: string | null;
    department_id?: string | null;
  },
  managerDepartmentsMap?: Map<string, Array<{ id: string; name: string }>>,
): string[] => {
  const ids = new Set<string>();
  if (row.department_id) {
    ids.add(String(row.department_id));
  }

  if (row.role === 'manager' && row.user_id && managerDepartmentsMap) {
    for (const dept of managerDepartmentsMap.get(String(row.user_id)) ?? []) {
      ids.add(dept.id);
    }
  }

  return Array.from(ids);
};

export const buildOverlapDepartmentIdsFromSummaries = (
  directDepartmentId: string | null | undefined,
  role: string | null | undefined,
  managedDepartments: Array<{ id: string; name: string }> | undefined,
): string[] => {
  const ids = new Set<string>();
  if (directDepartmentId) {
    ids.add(String(directDepartmentId));
  }
  if (role === 'manager' && managedDepartments) {
    for (const dept of managedDepartments) {
      ids.add(dept.id);
    }
  }
  return Array.from(ids);
};

export const resolveOverlapDepartmentIds = async (
  orgId: string,
  userId: string,
  role: string | null | undefined,
  directDepartmentId: string | null | undefined,
): Promise<string[]> => {
  const ids = new Set<string>();
  if (directDepartmentId) {
    ids.add(String(directDepartmentId));
  }

  if (role === 'manager') {
    const managed = await getManagedDepartmentIds(orgId, userId);
    for (const id of managed) {
      ids.add(id);
    }
  }

  return Array.from(ids);
};

export const calculateApprovedDepartmentTeammateOverlapCount = async (params: {
  org_id: string;
  request_id: string;
  user_id: string;
  department_ids: string[];
  start_date: string;
  end_date: string;
}): Promise<number> => {
  if (params.department_ids.length === 0) {
    return 0;
  }

  const overlapRow = await LeaveRequest.query()
    .alias('o')
    .leftJoin('users as u', 'u.id', 'o.user_id')
    .countDistinct('o.user_id as count')
    .where('o.org_id', params.org_id)
    .where('o.status', 'APPROVED')
    .whereIn('u.department_id', params.department_ids)
    .whereNot('o.user_id', params.user_id)
    .whereNot('o.id', params.request_id)
    .where((qb) => {
      qb.whereBetween('o.start_date', [params.start_date, params.end_date])
        .orWhereBetween('o.end_date', [params.start_date, params.end_date])
        .orWhere((inner) =>
          inner
            .where('o.start_date', '<=', params.start_date)
            .where('o.end_date', '>=', params.end_date),
        );
    })
    .first();

  return Number((overlapRow as { count?: string | number } | undefined)?.count ?? 0);
};
