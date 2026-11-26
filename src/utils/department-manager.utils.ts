import { Department } from '../models/Department';
import { DepartmentManager } from '../models/DepartmentManager';
import { User } from '../models/User';
import { parseDepartmentWorkingDays } from './attendance-schedule.utils';

export const getManagedDepartmentIds = async (
  orgId: string,
  managerUserId: string,
): Promise<string[]> => {
  const rows = await DepartmentManager.query()
    .alias('dm')
    .innerJoin('departments as d', 'd.id', 'dm.department_id')
    .where('d.org_id', orgId)
    .where('dm.manager_id', managerUserId)
    .select('dm.department_id');

  const mapped = rows.map((row: any) => String(row.department_id));

  // Keep backward compatibility with any legacy rows that still only use departments.manager_id.
  const legacyRows = await Department.query()
    .where('org_id', orgId)
    .where('manager_id', managerUserId)
    .select('id');
  for (const row of legacyRows) {
    mapped.push(row.id);
  }

  // Self-heal: if a manager has users.department_id but no department_managers rows,
  // create the mapping so manager-scoped APIs are consistent.
  if (mapped.length === 0) {
    const userRow = await User.query()
      .where('org_id', orgId)
      .where('id', managerUserId)
      .where('role', 'manager')
      .whereNull('deleted_at')
      .select('id', 'department_id')
      .first();
    const deptId = (userRow as any)?.department_id ? String((userRow as any).department_id) : null;
    if (deptId) {
      await DepartmentManager.query()
        .insert({ department_id: deptId, manager_id: managerUserId } as any)
        .onConflict(['department_id', 'manager_id'])
        .ignore();
      mapped.push(deptId);
    }
  }

  const result = Array.from(new Set(mapped));
  return result;
};

export type CancelActor = {
  id: string;
  org_id: string;
  role: string;
};

/**
 * Whether the actor may cancel a request owned by `requestOwnerUserId`.
 * Callers must already enforce same-org and status eligibility.
 *
 * Allowed: owner; admin/hr (org-wide); manager of an employee in a managed department.
 */
export const canCancelRequestForOwner = async (
  actor: CancelActor,
  requestOwnerUserId: string,
): Promise<boolean> => {
  const actorId = String(actor.id);
  const ownerId = String(requestOwnerUserId);

  if (actorId === ownerId) {
    return true;
  }

  const role = String(actor.role);
  if (role === 'admin' || role === 'hr') {
    return true;
  }

  if (role !== 'manager') {
    return false;
  }

  const owner = await User.query()
    .where('org_id', actor.org_id)
    .where('id', ownerId)
    .whereNull('deleted_at')
    .select('id', 'role', 'department_id')
    .first();

  if (!owner || String((owner as any).role) !== 'employee') {
    return false;
  }

  const departmentId = (owner as any).department_id ? String((owner as any).department_id) : null;
  if (!departmentId) {
    return false;
  }

  const managedDepartmentIds = await getManagedDepartmentIds(actor.org_id, actorId);
  return managedDepartmentIds.includes(departmentId);
};

export const getManagedDepartmentSummaries = async (
  orgId: string,
  managerUserIds: string[],
): Promise<Map<string, Array<{ id: string; name: string }>>> => {
  const uniqueManagerIds = Array.from(new Set(managerUserIds.map((id) => String(id)))).filter(
    (id) => id,
  );

  const map = new Map<string, Array<{ id: string; name: string }>>();

  if (uniqueManagerIds.length === 0) {
    return map;
  }

  const rows = await DepartmentManager.query()
    .alias('dm')
    .innerJoin('departments as d', 'd.id', 'dm.department_id')
    .where('d.org_id', orgId)
    .whereIn('dm.manager_id', uniqueManagerIds)
    .whereNull('d.deleted_at')
    .select('dm.manager_id', 'd.id as department_id', 'd.name as department_name')
    .orderBy('dm.created_at', 'asc');

  for (const row of rows as any[]) {
    const managerId = String(row.manager_id);
    if (!map.has(managerId)) {
      map.set(managerId, []);
    }
    map.get(managerId)!.push({
      id: String(row.department_id),
      name: String(row.department_name),
    });
  }

  // Keep backward compatibility with any legacy rows that still only use departments.manager_id.
  const legacyRows = await Department.query()
    .where('org_id', orgId)
    .whereIn('manager_id', uniqueManagerIds)
    .whereNull('deleted_at')
    .select('id', 'name', 'manager_id');

  for (const row of legacyRows as any[]) {
    const managerId = String(row.manager_id);
    if (!map.has(managerId)) {
      map.set(managerId, []);
    }

    const deptIdStr = String(row.id);
    const existing = map.get(managerId)!;

    if (!existing.some((d) => d.id === deptIdStr)) {
      existing.push({
        id: deptIdStr,
        name: String(row.name),
      });
    }
  }

  return map;
};

export type PrimaryManagedDepartmentSchedule = {
  departmentId: string;
  workingDays: string[] | null;
};

/**
 * First managed department per manager (by department_managers.created_at), with working_days.
 * Fills gaps from legacy departments.manager_id. Used when users.department_id is unset for managers.
 */
export async function fetchPrimaryManagedDepartmentScheduleByManagerIds(
  orgId: string,
  managerUserIds: string[],
): Promise<Map<string, PrimaryManagedDepartmentSchedule>> {
  const uniqueIds = Array.from(new Set(managerUserIds.map((id) => String(id)))).filter(Boolean);
  const result = new Map<string, PrimaryManagedDepartmentSchedule>();

  if (uniqueIds.length === 0) {
    return result;
  }

  const dmRows = await DepartmentManager.query()
    .alias('dm')
    .innerJoin('departments as d', 'd.id', 'dm.department_id')
    .where('d.org_id', orgId)
    .whereIn('dm.manager_id', uniqueIds)
    .whereNull('d.deleted_at')
    .select('dm.manager_id', 'dm.department_id', 'd.working_days as working_days')
    .orderBy('dm.created_at', 'asc');

  for (const row of dmRows as any[]) {
    const mid = String(row.manager_id);
    if (result.has(mid)) continue;
    result.set(mid, {
      departmentId: String(row.department_id),
      workingDays: parseDepartmentWorkingDays(row.working_days),
    });
  }

  const missing = uniqueIds.filter((id) => !result.has(id));
  if (missing.length === 0) {
    return result;
  }

  const legacyRows = await Department.query()
    .where('org_id', orgId)
    .whereIn('manager_id', missing)
    .whereNull('deleted_at')
    .select('id', 'manager_id', 'working_days');

  for (const row of legacyRows as any[]) {
    const mid = String(row.manager_id);
    if (result.has(mid)) continue;
    result.set(mid, {
      departmentId: String(row.id),
      workingDays: parseDepartmentWorkingDays(row.working_days),
    });
  }

  return result;
}
