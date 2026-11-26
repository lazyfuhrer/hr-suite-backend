import { Department } from '../models/Department';
import { User } from '../models/User';

export type ResolvedShiftTimes = {
  start_time: string | null;
  end_time: string | null;
  break_start_time?: string | null;
  break_end_time?: string | null;
  break_duration_mins?: number;
};

export const resolveShift = async (
  org_id: string,
  user_id: string,
): Promise<ResolvedShiftTimes | null> => {
  const user = await User.query()
    .withGraphJoined('[shift, department.defaultShift]')
    .where('users.id', user_id)
    .where('users.org_id', org_id)
    .first();

  if (!user) {
    return null;
  }

  const department = (user as User & { department?: { defaultShift?: ResolvedShiftTimes } })
    ?.department;
  let shift: ResolvedShiftTimes | null =
    (user as User & { shift?: ResolvedShiftTimes })?.shift ?? department?.defaultShift ?? null;

  // If no shift is configured directly or via department and the user is a manager,
  // fall back to the default shift of their first managed department (if any).
  if (!shift && (user as User & { role?: string }).role === 'manager') {
    const managedDeptWithShift = await Department.query()
      .alias('d')
      .innerJoin('department_managers as dm', 'dm.department_id', 'd.id')
      .leftJoin('work_shifts as ws', 'ws.id', 'd.default_shift_id')
      .where('d.org_id', org_id)
      .where('dm.manager_id', user_id)
      .whereNull('d.deleted_at')
      .whereNotNull('d.default_shift_id')
      .select(
        'ws.start_time',
        'ws.end_time',
        'ws.break_start_time',
        'ws.break_end_time',
        'ws.break_duration_mins',
      )
      .orderBy('dm.created_at', 'asc')
      .first();

    if (managedDeptWithShift) {
      const row = managedDeptWithShift as {
        start_time?: string | null;
        end_time?: string | null;
        break_start_time?: string | null;
        break_end_time?: string | null;
        break_duration_mins?: number | null;
      };
      shift = {
        start_time: row.start_time ?? null,
        end_time: row.end_time ?? null,
        break_start_time: row.break_start_time ?? null,
        break_end_time: row.break_end_time ?? null,
        break_duration_mins: row.break_duration_mins ?? 0,
      };
    }
  }

  return shift ?? null;
};
