import type { QueryBuilder } from 'objection';

export const USER_GRAPH_COLUMNS_FOR_SUMMARY = [
  'users.id',
  'users.org_id',
  'users.employee_id',
  'users.first_name',
  'users.last_name',
  'users.profile_image_url',
  'users.role',
  'users.designation',
  'users.department_id',
] as const;

export const applyUserDepartmentGraphSelect = <T extends QueryBuilder<any, any>>(query: T): T =>
  query
    .modifyGraph('user', (builder) => {
      builder.select(...USER_GRAPH_COLUMNS_FOR_SUMMARY);
    })
    .modifyGraph('user.department', (builder) => {
      builder.select('departments.id', 'departments.name');
    }) as T;

export type EmployeeSummary = {
  id: string;
  employee_id: string | null;
  full_name: string;
  role: string | null;
  designation: string | null;
  department: { id: string; name: string } | Array<{ id: string; name: string }> | null;
  profile_image_url: string | null;
};

export const buildEmployeeSummary = (source: any): EmployeeSummary | null => {
  if (!source) {
    return null;
  }

  const id = source.id ?? source.user_id ?? null;
  if (!id) {
    return null;
  }

  const role = source.role ?? null;
  const profile_image_url = source.profile_image_url ?? null;

  // For manager users, support multiple departments (array of objects)
  if (role === 'manager' && Array.isArray(source.manager_departments)) {
    const uniqueDepartments: Array<{ id: string; name: string }> = [];
    const seen = new Set<string>();

    for (const d of source.manager_departments as Array<{ id: string; name: string }>) {
      const deptId = String(d.id);
      if (seen.has(deptId)) continue;
      seen.add(deptId);
      uniqueDepartments.push({
        id: deptId,
        name: String(d.name),
      });
    }

    return {
      id: String(id),
      employee_id: source.employee_id ?? null,
      full_name: `${source.first_name ?? ''} ${source.last_name ?? ''}`.trim(),
      role,
      designation: source.designation ?? null,
      department: uniqueDepartments.length > 0 ? uniqueDepartments : null,
      profile_image_url,
    };
  }

  const departmentId = source.department_id ?? source.department?.id ?? null;
  const departmentName = source.department_name ?? source.department?.name ?? null;

  return {
    id: String(id),
    employee_id: source.employee_id ?? null,
    full_name: `${source.first_name ?? ''} ${source.last_name ?? ''}`.trim(),
    role,
    designation: source.designation ?? null,
    department:
      departmentId && departmentName
        ? {
            id: String(departmentId),
            name: String(departmentName),
          }
        : null,
    profile_image_url,
  };
};
