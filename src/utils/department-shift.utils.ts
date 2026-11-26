import { Department } from '../models/Department';
import { WorkShift } from '../models/WorkShift';

export type WorkShiftSummary = {
  id: string;
  name: string;
  start_time: string;
  end_time: string;
  break_start_time: string;
  break_end_time: string;
  break_duration_mins: number;
};

const uniqueIds = (ids: string[]): string[] => Array.from(new Set(ids));

export const normalizeDepartmentShiftIds = (department: {
  work_shift_ids?: string[] | null;
  default_shift_id?: string | null;
}): string[] => {
  if (Array.isArray(department?.work_shift_ids)) {
    return uniqueIds(
      department.work_shift_ids.filter((id: unknown): id is string => typeof id === 'string'),
    );
  }
  return typeof department?.default_shift_id === 'string' ? [department.default_shift_id] : [];
};

const WORK_SHIFT_SELECT = [
  'id',
  'name',
  'start_time',
  'end_time',
  'break_start_time',
  'break_end_time',
  'break_duration_mins',
] as const;

export const fetchWorkShiftsByDepartmentIds = async (
  orgId: string,
  departmentIds: string[],
): Promise<Map<string, WorkShiftSummary[]>> => {
  const result = new Map<string, WorkShiftSummary[]>();
  const uniqueDeptIds = uniqueIds(departmentIds.filter(Boolean));

  if (uniqueDeptIds.length === 0) {
    return result;
  }

  const departments = await Department.query()
    .where('org_id', orgId)
    .whereIn('id', uniqueDeptIds)
    .whereNull('deleted_at')
    .select('id', 'work_shift_ids', 'default_shift_id');

  const allShiftIds = uniqueIds(
    departments.flatMap((department) => normalizeDepartmentShiftIds(department)),
  );

  const shifts =
    allShiftIds.length > 0
      ? await WorkShift.query()
          .where('org_id', orgId)
          .whereIn('id', allShiftIds)
          .select(...WORK_SHIFT_SELECT)
      : [];

  const shiftMap = new Map<string, WorkShiftSummary>(
    shifts.map((shift) => [
      shift.id,
      {
        id: shift.id,
        name: shift.name,
        start_time: shift.start_time,
        end_time: shift.end_time,
        break_start_time: shift.break_start_time,
        break_end_time: shift.break_end_time,
        break_duration_mins: shift.break_duration_mins,
      },
    ]),
  );

  for (const department of departments) {
    const shiftIds = normalizeDepartmentShiftIds(department);
    result.set(
      department.id,
      shiftIds
        .map((id) => shiftMap.get(id))
        .filter((shift): shift is WorkShiftSummary => Boolean(shift)),
    );
  }

  for (const deptId of uniqueDeptIds) {
    if (!result.has(deptId)) {
      result.set(deptId, []);
    }
  }

  return result;
};

export const resolveEmployeeWorkShifts = (
  departmentIds: string[],
  shiftsByDeptId: Map<string, WorkShiftSummary[]>,
): WorkShiftSummary[] => {
  const uniqueDeptIds = uniqueIds(departmentIds.filter(Boolean));
  const seenShiftIds = new Set<string>();
  const workShifts: WorkShiftSummary[] = [];

  for (const deptId of uniqueDeptIds) {
    for (const shift of shiftsByDeptId.get(deptId) ?? []) {
      if (seenShiftIds.has(shift.id)) {
        continue;
      }
      seenShiftIds.add(shift.id);
      workShifts.push(shift);
    }
  }

  return workShifts;
};
