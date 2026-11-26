import type { Request, Response } from 'express';

import { Department } from '../../models/Department';
import { DepartmentManager } from '../../models/DepartmentManager';
import { OfficeLocation } from '../../models/OfficeLocation';
import { User } from '../../models/User';
import { UserOnboarding } from '../../models/UserOnboarding';
import { WorkShift } from '../../models/WorkShift';
import { ORG_USER_ROLES } from '../../constants/user-roles';
import { REAL_EMPLOYEE_STATUSES } from '../../constants/user-status';
import { getManagedDepartmentIds } from '../../utils/department-manager.utils';
import { normalizeDepartmentShiftIds } from '../../utils/department-shift.utils';
import { applyResignedUsersInPeriodFilter } from '../../utils/user-exit.utils';
import {
  applyExcludeInProgressOnboardingFilter,
  isKycFlowEnabledForOrg,
} from '../../utils/user-visibility.utils';
import { invalidateTenantSessionsForDepartment } from '../../utils/session-invalidation.utils';
import {
  assignDepartmentEmployeesSchema,
  createDepartmentSchema,
  departmentDashboardQuerySchema,
  departmentDetailsQuerySchema,
  departmentListQuerySchema,
  departmentStatisticsQuerySchema,
  updateDepartmentManagerSchema,
  updateDepartmentSchema,
  departmentEmployeeListQuerySchema,
} from '../../validators';

const withManagerIds = (department: any): any => {
  const json =
    department && typeof department.toJSON === 'function' ? department.toJSON() : { ...department };
  const legacyManagerId = json.manager_id;
  const managerIdsFromRelation = Array.isArray(json.managers)
    ? json.managers
        .map((manager: any) => manager?.id)
        .filter((id: unknown): id is string => typeof id === 'string')
    : [];
  const managerIds =
    managerIdsFromRelation.length > 0
      ? Array.from(new Set(managerIdsFromRelation))
      : legacyManagerId
        ? [legacyManagerId]
        : [];
  const { manager_id: _legacyManagerId, manager: _legacyManager, ...rest } = json;

  return {
    ...rest,
    manager_ids: managerIds,
  };
};

const uniqueIds = (ids: string[]): string[] => Array.from(new Set(ids));
const applyKycVerifiedFilter = (query: any, userAlias = 'users', kycFlowEnabled = true): any => {
  if (!kycFlowEnabled) {
    return query;
  }

  applyExcludeInProgressOnboardingFilter(query, userAlias);
  return query.whereExists(
    UserOnboarding.query()
      .select(1)
      .whereRaw('user_onboardings.user_id = ??', [`${userAlias}.id`])
      .where((qb: any) => {
        qb.where('user_onboardings.kyc_status', 'VERIFIED').orWhere(
          'user_onboardings.kyc_gating_exempt',
          true,
        );
      }),
  );
};

// Assignment UI visibility:
// - Never include onboarding still IN_PROGRESS
// - Do NOT gate on KYC verified/exempt (counts should not change with KYC toggle)
const applyAssignmentVisibilityFilter = (query: any, userAlias = 'users'): any => {
  return applyExcludeInProgressOnboardingFilter(query, userAlias);
};
const WEEKDAYS = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
] as const;

const normalizeDepartmentLocationIds = (department: any): string[] => {
  if (Array.isArray(department?.location_ids)) {
    return uniqueIds(
      department.location_ids.filter((id: unknown): id is string => typeof id === 'string'),
    );
  }
  return typeof department?.location_id === 'string' ? [department.location_id] : [];
};

const withAssignmentCollections = async (departments: any[], org_id: string): Promise<any[]> => {
  if (departments.length === 0) return departments;

  const allLocationIds = uniqueIds(
    departments.flatMap((department) => normalizeDepartmentLocationIds(department)),
  );
  const allShiftIds = uniqueIds(
    departments.flatMap((department) => normalizeDepartmentShiftIds(department)),
  );

  const [locations, shifts] = await Promise.all([
    allLocationIds.length > 0
      ? OfficeLocation.query()
          .where('org_id', org_id)
          .whereIn('id', allLocationIds)
          .select('id', 'name', 'latitude', 'longitude', 'radius_meters', 'address')
      : [],
    allShiftIds.length > 0
      ? WorkShift.query()
          .where('org_id', org_id)
          .whereIn('id', allShiftIds)
          .select(
            'id',
            'name',
            'start_time',
            'end_time',
            'break_start_time',
            'break_end_time',
            'break_duration_mins',
          )
      : [],
  ]);

  const locationMap = new Map(locations.map((location) => [location.id, location]));
  const shiftMap = new Map(shifts.map((shift) => [shift.id, shift]));

  return departments.map((department) => {
    const location_ids = normalizeDepartmentLocationIds(department);
    const work_shift_ids = normalizeDepartmentShiftIds(department);
    return {
      ...department,
      location_ids,
      work_shift_ids,
      locations: location_ids.map((id) => locationMap.get(id)).filter(Boolean),
      work_shifts: work_shift_ids.map((id) => shiftMap.get(id)).filter(Boolean),
    };
  });
};

/**
 * `Department.managers` only loads rows from `department_managers`. Managers tied to a
 * department solely via `users.department_id` (e.g. onboarding) must be merged so API
 * payloads match headcount logic in `getDepartmentEmployeeCountMap`.
 */
const mergeManagersFromDepartmentUserAssignment = async (
  departments: any[],
  org_id: string,
  fields: 'list' | 'detail',
  kycFlowEnabled: boolean,
): Promise<void> => {
  if (departments.length === 0) return;
  const departmentIds = departments
    .map((d) => d?.id)
    .filter((id): id is string => typeof id === 'string');
  if (departmentIds.length === 0) return;

  const baseQuery = User.query()
    .where('org_id', org_id)
    .where('role', 'manager')
    .whereIn('department_id', departmentIds)
    .where('status', 'ACTIVE')
    .whereNull('deleted_at')
    .modify((qb) => applyKycVerifiedFilter(qb, 'users', kycFlowEnabled));

  if (fields === 'list') {
    baseQuery.select('id', 'first_name', 'last_name', 'profile_image_url', 'department_id');
  } else {
    baseQuery.select(
      'id',
      'first_name',
      'last_name',
      'profile_image_url',
      'official_email',
      'role',
      'status',
      'department_id',
    );
  }

  const rows = await baseQuery;
  const byDept = new Map<string, any[]>();
  for (const row of rows) {
    const did = row.department_id;
    if (typeof did !== 'string') continue;
    const rest =
      fields === 'list'
        ? {
            id: row.id,
            first_name: row.first_name,
            last_name: row.last_name,
            profile_image_url: row.profile_image_url ?? null,
          }
        : {
            id: row.id,
            first_name: row.first_name,
            last_name: row.last_name,
            profile_image_url: row.profile_image_url ?? null,
            official_email: row.official_email,
            role: row.role,
            status: row.status,
          };
    if (!byDept.has(did)) byDept.set(did, []);
    byDept.get(did)!.push(rest);
  }

  for (const d of departments) {
    const fromJunction = Array.isArray(d.managers) ? [...d.managers] : [];
    const fromDeptId = byDept.get(d.id) ?? [];
    const seen = new Set(
      fromJunction
        .map((m: { id?: string }) => m?.id)
        .filter((id): id is string => typeof id === 'string'),
    );
    const merged = [...fromJunction];
    for (const m of fromDeptId) {
      const mid = (m as { id?: string }).id;
      if (typeof mid === 'string' && !seen.has(mid)) {
        merged.push(m);
        seen.add(mid);
      }
    }
    d.managers = merged;
  }
};

export class DepartmentController {
  static async create(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = createDepartmentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const {
      name,
      manager_id,
      manager_ids,
      employee_ids,
      location_id,
      location_ids,
      default_shift_id,
      work_shift_ids,
      location,
      default_shift,
      working_days,
      location_tracking_enabled,
    } = parsed.data;
    const org_id = req.user.org_id;
    const normalizedManagerIds =
      manager_ids !== undefined
        ? Array.from(new Set(manager_ids))
        : manager_id !== undefined
          ? manager_id
            ? [manager_id]
            : []
          : undefined;

    const existing = await Department.query().findOne({ org_id, name });
    if (existing) {
      return res.status(409).json({ message: 'Department already exists' });
    }

    const trx = await Department.startTransaction();
    try {
      const created = await Department.query(trx).insert({
        org_id,
        name,
        working_days: working_days ?? null,
        location_tracking_enabled: location_tracking_enabled ?? false,
      });

      let effectiveLocationIds: string[] | undefined =
        location_ids !== undefined
          ? uniqueIds(location_ids)
          : location_id !== undefined
            ? location_id
              ? [location_id]
              : []
            : undefined;

      if (effectiveLocationIds && effectiveLocationIds.length > 0) {
        const existingLocations = await OfficeLocation.query(trx)
          .where('org_id', org_id)
          .whereIn('id', effectiveLocationIds)
          .select('id');
        if (existingLocations.length !== effectiveLocationIds.length) {
          await trx.rollback();
          return res.status(400).json({ message: 'Invalid location_ids' });
        }
      }

      if (location) {
        const createdLocation = await OfficeLocation.query(trx).insert({
          org_id,
          name: location.name,
          latitude: location.latitude,
          longitude: location.longitude,
          radius_meters: location.radius_meters,
        } as any);
        effectiveLocationIds = uniqueIds([...(effectiveLocationIds ?? []), createdLocation.id]);
      }

      let effectiveShiftIds: string[] | undefined =
        work_shift_ids !== undefined
          ? uniqueIds(work_shift_ids)
          : default_shift_id !== undefined
            ? default_shift_id
              ? [default_shift_id]
              : []
            : undefined;

      if (effectiveShiftIds && effectiveShiftIds.length > 0) {
        const existingShifts = await WorkShift.query(trx)
          .where('org_id', org_id)
          .whereIn('id', effectiveShiftIds)
          .select('id');
        if (existingShifts.length !== effectiveShiftIds.length) {
          await trx.rollback();
          return res.status(400).json({ message: 'Invalid work_shift_ids' });
        }
      }

      if (default_shift) {
        const createdShift = await WorkShift.query(trx).insert({
          org_id,
          name: default_shift.name,
          start_time: default_shift.start_time,
          end_time: default_shift.end_time,
          break_start_time: default_shift.break_start_time,
          break_end_time: default_shift.break_end_time,
          break_duration_mins: default_shift.break_duration_mins,
        } as any);
        effectiveShiftIds = uniqueIds([...(effectiveShiftIds ?? []), createdShift.id]);
      }

      if (effectiveLocationIds !== undefined || effectiveShiftIds !== undefined) {
        await Department.query(trx)
          .patch({
            ...(effectiveLocationIds !== undefined
              ? {
                  location_ids: effectiveLocationIds.length > 0 ? effectiveLocationIds : null,
                  location_id: effectiveLocationIds[0] ?? null,
                }
              : {}),
            ...(effectiveShiftIds !== undefined
              ? {
                  work_shift_ids: effectiveShiftIds.length > 0 ? effectiveShiftIds : null,
                  default_shift_id: effectiveShiftIds[0] ?? null,
                }
              : {}),
          })
          .where('id', created.id);
      }

      // Optional manager assignment (supports multiple managers).
      if (normalizedManagerIds !== undefined) {
        const managerIdsToAssign = normalizedManagerIds;
        if (managerIdsToAssign.length > 0) {
          const managers = await User.query(trx)
            .whereIn('id', managerIdsToAssign)
            .where('org_id', org_id)
            .whereNull('deleted_at');

          if (managers.length !== managerIdsToAssign.length) {
            await trx.rollback();
            return res.status(400).json({ message: 'Invalid manager_ids' });
          }

          if (managers.some((manager) => manager.status !== 'ACTIVE')) {
            await trx.rollback();
            return res.status(400).json({ message: 'All managers must be ACTIVE' });
          }

          await User.query(trx)
            .patch({ department_id: created.id })
            .whereIn('id', managerIdsToAssign);
          await DepartmentManager.query(trx).insert(
            managerIdsToAssign.map((managerUserId) => ({
              department_id: created.id,
              manager_id: managerUserId,
            })),
          );
        }

        await Department.query(trx)
          .patch({
            // Keep legacy field in sync for backward compatibility.
            manager_id: managerIdsToAssign[0] ?? null,
          })
          .where('id', created.id);
      }

      // Optional employees assignment
      if (employee_ids && employee_ids.length > 0) {
        const employees = await User.query(trx)
          .whereIn('id', employee_ids)
          .where('org_id', org_id)
          .whereNull('deleted_at');

        if (employees.length !== employee_ids.length) {
          const foundIds = new Set(employees.map((u) => u.id));
          const missing = employee_ids.filter((empId) => !foundIds.has(empId));

          await trx.rollback();
          return res.status(400).json({
            message: 'Some employees were not found in this organization',
            missing_employee_ids: missing,
          });
        }

        await User.query(trx).patch({ department_id: created.id }).whereIn('id', employee_ids);
      }

      await trx.commit();

      const full = await Department.query()
        .where('id', created.id)
        .withGraphFetched('[location, defaultShift, manager, managers, users]')
        .modifyGraph('managers', (builder) => {
          builder.select(
            'id',
            'first_name',
            'last_name',
            'profile_image_url',
            'official_email',
            'role',
            'status',
          );
        })
        .first();
      if (full) {
        await mergeManagersFromDepartmentUserAssignment(
          [full],
          org_id,
          'detail',
          await isKycFlowEnabledForOrg(org_id),
        );
      }
      const [payload] = await withAssignmentCollections([withManagerIds(full)], org_id);
      return res.status(201).json(payload);
    } catch (err) {
      await trx.rollback();
      throw err;
    }
  }

  static async list(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = departmentListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { page, limit, search, status, sort_by, sort_dir, from_date, to_date } = parsed.data;
    const org_id = req.user.org_id;
    const kycFlowEnabled = await isKycFlowEnabledForOrg(org_id);

    const base = Department.query().where('org_id', org_id);
    if (status === 'ACTIVE') base.whereNull('deleted_at');
    if (status === 'INACTIVE') base.whereNotNull('deleted_at');
    if (search) {
      base.where('name', 'ilike', `%${search}%`);
    }
    if (from_date && to_date) {
      const fromDateStart = new Date(`${from_date}T00:00:00.000Z`);
      const toDateEnd = new Date(`${to_date}T23:59:59.999Z`);
      base.whereBetween('created_at', [fromDateStart, toDateEnd]);
    }

    let departments = [];
    let total = 0;
    let safePage = page;
    const knex = Department.knex();
    const getDepartmentEmployeeCountMap = async (
      departmentIds: string[],
    ): Promise<Map<string, number>> => {
      if (departmentIds.length === 0) {
        return new Map<string, number>();
      }

      // Rule for consistent headcount:
      // - Include only ACTIVE users with VERIFIED KYC
      // - Employees/HR by users.department_id
      // - Managers by users.department_id OR department_managers
      const employeeQuery = User.query()
        .where('org_id', org_id)
        .whereIn('role', ['employee', 'hr'])
        .where('status', 'ACTIVE')
        .whereNull('deleted_at')
        .whereIn('department_id', departmentIds);
      applyKycVerifiedFilter(employeeQuery, 'users', kycFlowEnabled);
      const employeeRows = await employeeQuery
        .select('department_id')
        .count('* as count')
        .groupBy('department_id');

      const employeeCountMap = new Map(
        (employeeRows as unknown as Array<{ department_id: string; count: string | number }>).map(
          (row) => [row.department_id, Number(row.count ?? 0)],
        ),
      );

      const managerCombined = knex
        .select('u.id as user_id', 'u.department_id as department_id')
        .from('users as u')
        .innerJoin('user_onboardings as uo', 'uo.user_id', 'u.id')
        .where('u.org_id', org_id)
        .where('u.role', 'manager')
        .where('u.status', 'ACTIVE')
        .whereNull('u.deleted_at')
        .modify((qb: any) => {
          if (kycFlowEnabled) {
            qb.where((w: any) => {
              w.where('uo.kyc_status', 'VERIFIED').orWhere('uo.kyc_gating_exempt', true);
            }).whereNot('uo.onboarding_status', 'IN_PROGRESS');
          }
        })
        .whereIn('u.department_id', departmentIds)
        .union(
          knex
            .select('u.id as user_id', 'dm.department_id as department_id')
            .from('department_managers as dm')
            .innerJoin('users as u', 'u.id', 'dm.manager_id')
            .innerJoin('user_onboardings as uo', 'uo.user_id', 'u.id')
            .where('u.org_id', org_id)
            .where('u.role', 'manager')
            .where('u.status', 'ACTIVE')
            .whereNull('u.deleted_at')
            .modify((qb: any) => {
              if (kycFlowEnabled) {
                qb.where((w: any) => {
                  w.where('uo.kyc_status', 'VERIFIED').orWhere('uo.kyc_gating_exempt', true);
                }).whereNot('uo.onboarding_status', 'IN_PROGRESS');
              }
            })
            .whereIn('dm.department_id', departmentIds),
        )
        .as('mgr');

      const managerRows = await knex
        .select('mgr.department_id')
        .countDistinct('mgr.user_id as count')
        .from(managerCombined)
        .groupBy('mgr.department_id');

      const managerCountMap = new Map(
        (managerRows as Array<{ department_id: string; count: string | number }>).map((row) => [
          row.department_id,
          Number(row.count ?? 0),
        ]),
      );

      const merged = new Map<string, number>();
      for (const departmentId of departmentIds) {
        merged.set(
          departmentId,
          (employeeCountMap.get(departmentId) ?? 0) + (managerCountMap.get(departmentId) ?? 0),
        );
      }
      return merged;
    };

    if (sort_by === 'EMPLOYEE_COUNT') {
      const all = await base
        .clone()
        .withGraphFetched('[location, defaultShift, manager, managers]')
        .modifyGraph('manager', (builder) => {
          builder.select('id', 'first_name', 'last_name', 'profile_image_url');
        })
        .modifyGraph('managers', (builder) => {
          builder.select('id', 'first_name', 'last_name', 'profile_image_url');
        });

      await mergeManagersFromDepartmentUserAssignment(all, org_id, 'list', kycFlowEnabled);

      const ids = all.map((d) => d.id);
      const countsMap = await getDepartmentEmployeeCountMap(ids);

      const mapped = all.map((d) => {
        return withManagerIds({
          ...d,
          employee_count: countsMap.get(d.id) ?? 0,
          created_on: d.created_at,
          status: d.deleted_at ? 'INACTIVE' : 'ACTIVE',
        });
      });

      mapped.sort((a, b) => {
        const diff = (a.employee_count ?? 0) - (b.employee_count ?? 0);
        return sort_dir === 'DESC' ? -diff : diff;
      });

      total = mapped.length;
      const total_pages = Math.max(1, Math.ceil(total / limit));
      safePage = Math.min(Math.max(page, 1), total_pages);
      const start = (safePage - 1) * limit;
      departments = mapped.slice(start, start + limit);
    } else {
      const countRow = await base.clone().count('* as count').first();
      total = Number((countRow as unknown as { count?: string | number })?.count ?? 0);
      const total_pages = Math.max(1, Math.ceil(total / limit));
      safePage = Math.min(Math.max(page, 1), total_pages);
      const offset = (safePage - 1) * limit;

      if (sort_by === 'NAME') {
        base.orderBy('name', sort_dir === 'DESC' ? 'desc' : 'asc');
      } else if (sort_by === 'CREATED_ON') {
        base.orderBy('created_at', sort_dir === 'DESC' ? 'desc' : 'asc');
      } else if (sort_by === 'STATUS') {
        base.orderByRaw(`deleted_at IS NULL ${sort_dir === 'DESC' ? 'asc' : 'desc'}`);
      } else if (sort_by === 'MANAGER') {
        base.orderBy('manager_id', sort_dir === 'DESC' ? 'desc' : 'asc');
      }

      const rows = await base
        .clone()
        .withGraphFetched('[location, defaultShift, manager, managers]')
        .modifyGraph('manager', (builder) => {
          builder.select('id', 'first_name', 'last_name', 'profile_image_url');
        })
        .modifyGraph('managers', (builder) => {
          builder.select('id', 'first_name', 'last_name', 'profile_image_url');
        })
        .offset(offset)
        .limit(limit);

      await mergeManagersFromDepartmentUserAssignment(rows, org_id, 'list', kycFlowEnabled);

      const ids = rows.map((d) => d.id);
      const countsMap = await getDepartmentEmployeeCountMap(ids);

      departments = rows.map((d) => {
        return withManagerIds({
          ...d,
          employee_count: countsMap.get(d.id) ?? 0,
          created_on: d.created_at,
          status: d.deleted_at ? 'INACTIVE' : 'ACTIVE',
        });
      });
    }

    const data = await withAssignmentCollections(departments, org_id);
    const total_pages = Math.max(1, Math.ceil(total / limit));
    return res.json({
      page: safePage,
      limit,
      total,
      total_pages,
      data,
    });
  }

  static async getById(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = departmentDetailsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { id } = req.params;
    const { limit, status, sort_by, sort_dir } = parsed.data;
    const org_id = req.user.org_id;
    const kycFlowEnabled = await isKycFlowEnabledForOrg(org_id);
    // Stable semantics for department assignment payload:
    // always exclude IN_PROGRESS members from selected/unselected pools and headcount,
    // regardless of KYC toggle.
    const effectiveEmployeeStatuses = REAL_EMPLOYEE_STATUSES as readonly string[];

    const department = await Department.query()
      .where('id', id)
      .where('org_id', org_id)
      .withGraphFetched('[managers]')
      .modifyGraph('managers', (builder) => {
        builder.select(
          'id',
          'first_name',
          'last_name',
          'profile_image_url',
          'official_email',
          'role',
          'status',
        );
      })
      .first();

    if (!department) {
      return res.status(404).json({ message: 'Department not found' });
    }

    await mergeManagersFromDepartmentUserAssignment([department], org_id, 'detail', kycFlowEnabled);
    const departmentPayload = withManagerIds(department);
    const selectedManagerIds = uniqueIds(departmentPayload.manager_ids ?? []);
    const selectedLocationIds = normalizeDepartmentLocationIds(departmentPayload);
    const selectedShiftIds = normalizeDepartmentShiftIds(departmentPayload);
    const selectedWorkingDays = uniqueIds(
      ((departmentPayload.working_days ?? []) as string[])
        .map((day) => (typeof day === 'string' ? day.toUpperCase() : ''))
        .filter((day): day is string => (WEEKDAYS as readonly string[]).includes(day)),
    );

    const applyEmployeeStatusAndSort = (query: any): void => {
      if (status !== 'ALL') {
        query.where('status', status);
      }

      if (sort_by === 'JOIN_DATE') {
        query.orderBy('date_of_joining', sort_dir === 'DESC' ? 'desc' : 'asc');
      } else if (sort_by === 'STATUS') {
        query.orderBy('status', sort_dir === 'DESC' ? 'desc' : 'asc');
      } else {
        query.orderBy([
          { column: 'first_name', order: sort_dir === 'DESC' ? 'desc' : 'asc' },
          { column: 'last_name', order: sort_dir === 'DESC' ? 'desc' : 'asc' },
        ]);
      }
      query.orderBy('created_at', 'desc');
    };

    const selectedEmployeesBase = User.query()
      .where('org_id', org_id)
      .whereIn('role', ['employee', 'hr'])
      .whereIn('status', effectiveEmployeeStatuses)
      .where('department_id', id)
      .whereNull('deleted_at');
    applyAssignmentVisibilityFilter(selectedEmployeesBase, 'users');
    if (status !== 'ALL') {
      selectedEmployeesBase.where('status', status);
    }

    const selectedEmployeesCountRow = await selectedEmployeesBase
      .clone()
      .count('* as count')
      .first();
    const selectedEmployeesTotal = Number(
      (selectedEmployeesCountRow as unknown as { count?: string | number })?.count ?? 0,
    );
    // This endpoint returns a non-paginated selected_users list (per product requirement).
    // Keep page/limit in the response for backward compatibility, but always return the full list.
    const selectedEmployeesTotalPages = 1;
    const safePage = 1;

    const [
      selectedEmployees,
      selectedEmployeeIdsRows,
      managerPool,
      employeePool,
      locationPool,
      shiftPool,
    ] = await Promise.all([
      (() => {
        const selectedEmployeesDataQuery = selectedEmployeesBase
          .clone()
          .select(
            'id',
            'employee_id',
            'first_name',
            'last_name',
            'profile_image_url',
            'official_email',
            'role',
            'status',
            'department_id',
          );
        applyEmployeeStatusAndSort(selectedEmployeesDataQuery);
        return selectedEmployeesDataQuery;
      })(),
      User.query().modify((qb) => {
        applyAssignmentVisibilityFilter(qb, 'users');
        qb.where('org_id', org_id)
          .whereIn('role', ['employee', 'hr'])
          .whereIn('status', effectiveEmployeeStatuses)
          .where('department_id', id)
          .whereNull('deleted_at')
          .select('id');
      }),
      User.query().modify((qb) => {
        applyAssignmentVisibilityFilter(qb, 'users');
        qb.where('org_id', org_id)
          .where('role', 'manager')
          .whereIn('status', effectiveEmployeeStatuses)
          .whereNull('deleted_at')
          .select(
            'id',
            'employee_id',
            'first_name',
            'last_name',
            'profile_image_url',
            'official_email',
            'role',
            'status',
            'department_id',
          );
      }),
      (() => {
        const employeePoolBase = User.query()
          .where('org_id', org_id)
          .whereIn('role', ['employee', 'hr'])
          .whereIn('status', effectiveEmployeeStatuses)
          // Unselected users = truly unassigned employees/hr only.
          .whereNull('department_id')
          .whereNull('deleted_at')
          .select(
            'id',
            'employee_id',
            'first_name',
            'last_name',
            'profile_image_url',
            'official_email',
            'role',
            'status',
            'department_id',
          );
        applyAssignmentVisibilityFilter(employeePoolBase, 'users');
        applyEmployeeStatusAndSort(employeePoolBase);
        return employeePoolBase;
      })(),
      OfficeLocation.query()
        .where('org_id', org_id)
        .select('id', 'name', 'latitude', 'longitude', 'radius_meters', 'address'),
      WorkShift.query()
        .where('org_id', org_id)
        .select(
          'id',
          'name',
          'start_time',
          'end_time',
          'break_start_time',
          'break_end_time',
          'break_duration_mins',
        ),
    ]);

    const [selectedManagers, managersAssignedByDepartmentField] = await Promise.all([
      selectedManagerIds.length > 0
        ? User.query().modify((qb) => {
            applyAssignmentVisibilityFilter(qb, 'users');
            qb.where('org_id', org_id)
              .whereIn('id', selectedManagerIds)
              .where('role', 'manager')
              .whereIn('status', effectiveEmployeeStatuses)
              .whereNull('deleted_at')
              .select(
                'id',
                'employee_id',
                'first_name',
                'last_name',
                'profile_image_url',
                'official_email',
                'role',
                'status',
                'department_id',
              );
          })
        : [],
      User.query().modify((qb) => {
        applyAssignmentVisibilityFilter(qb, 'users');
        qb.where('org_id', org_id)
          .where('role', 'manager')
          .whereIn('status', effectiveEmployeeStatuses)
          .where('department_id', id)
          .whereNull('deleted_at')
          .select(
            'id',
            'employee_id',
            'first_name',
            'last_name',
            'profile_image_url',
            'official_email',
            'role',
            'status',
            'department_id',
          );
      }),
    ]);

    const managerPoolById = new Map((managerPool as any[]).map((manager) => [manager.id, manager]));
    const selectedManagersById = new Map(selectedManagers.map((manager) => [manager.id, manager]));
    const selectedManagerIdsFromDepartmentField = managersAssignedByDepartmentField.map(
      (manager) => manager.id,
    );
    const mergedSelectedManagerIds = uniqueIds([
      ...selectedManagerIds,
      ...selectedManagerIdsFromDepartmentField,
    ]);
    const selectedManagersOrdered = mergedSelectedManagerIds
      .map((managerId) => selectedManagersById.get(managerId) ?? managerPoolById.get(managerId))
      .filter((manager): manager is User => Boolean(manager));
    const selectedManagerIdsStrict = selectedManagersOrdered.map((manager) => manager.id);
    const selectedManagerIdSet = new Set(selectedManagerIdsStrict);
    const selectedEmployeeIdSet = new Set(selectedEmployeeIdsRows.map((employee) => employee.id));
    const selectedLocationIdSet = new Set(selectedLocationIds);
    const selectedShiftIdSet = new Set(selectedShiftIds);
    const selectedWorkingDaySet = new Set(selectedWorkingDays);
    const locationById = new Map(locationPool.map((location) => [location.id, location]));
    const shiftById = new Map(shiftPool.map((shift) => [shift.id, shift]));

    const {
      managers: _legacyManagers,
      users: _legacyUsers,
      manager: _legacyManager,
      ...rest
    } = departmentPayload;

    const member_count = selectedEmployeesTotal + selectedManagerIdsStrict.length;
    return res.json({
      ...rest,
      // Align with department list `employee_count` semantics (headcount includes managers).
      member_count,
      // Backward/UX compatibility: the list endpoint uses `employee_count` for headcount.
      employee_count: member_count,
      manager_ids: selectedManagerIdsStrict,
      location_ids: selectedLocationIds,
      work_shift_ids: selectedShiftIds,
      working_days: selectedWorkingDays,
      managers: {
        selected_managers: selectedManagersOrdered,
        unselected_managers: managerPool.filter((manager) => !selectedManagerIdSet.has(manager.id)),
      },
      employees: {
        selected_users: selectedEmployees,
        unselected_users: employeePool.filter(
          (employee) => !selectedEmployeeIdSet.has(employee.id),
        ),
        // These fields remove ambiguity between paginated page-size vs totals.
        selected_users_count_on_page: selectedEmployees.length,
        selected_users_total: selectedEmployeesTotal,
        members_total_including_managers: member_count,
        page: safePage,
        limit,
        total_selected: selectedEmployeesTotal,
        total_pages: selectedEmployeesTotalPages,
      },
      locations: {
        selected_locations: selectedLocationIds
          .map((locId) => locationById.get(locId))
          .filter(Boolean),
        unselected_locations: locationPool.filter(
          (location) => !selectedLocationIdSet.has(location.id),
        ),
      },
      shifts: {
        selected_shifts: selectedShiftIds.map((shiftId) => shiftById.get(shiftId)).filter(Boolean),
        unselected_shifts: shiftPool.filter((shift) => !selectedShiftIdSet.has(shift.id)),
      },
      workings_days: {
        selected_working_days: selectedWorkingDays,
        unselected_working_days: WEEKDAYS.filter((day) => !selectedWorkingDaySet.has(day)),
      },
    });
  }

  static async update(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    const org_id = req.user.org_id;

    const parsed = updateDepartmentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const {
      name,
      manager_id,
      manager_ids,
      employee_ids,
      location_id,
      location_ids,
      default_shift_id,
      work_shift_ids,
      location,
      default_shift,
      working_days,
      location_tracking_enabled,
    } = parsed.data;
    const normalizedManagerIds =
      manager_ids !== undefined
        ? Array.from(new Set(manager_ids))
        : manager_id !== undefined
          ? manager_id
            ? [manager_id]
            : []
          : undefined;

    const department = await Department.query().where({ id, org_id }).first();

    if (!department) {
      return res.status(404).json({ message: 'Department not found' });
    }

    const trx = await Department.startTransaction();
    try {
      const updateData: any = {};

      if (name !== undefined && name !== department.name) {
        const existing = await Department.query(trx).findOne({ org_id, name }).whereNot('id', id);
        if (existing) {
          await trx.rollback();
          return res.status(409).json({ message: 'Department with this name already exists' });
        }
        updateData.name = name;
      }

      if (working_days !== undefined) updateData.working_days = working_days;
      const previousLocationTrackingEnabled = department.location_tracking_enabled === true;
      if (location_tracking_enabled !== undefined) {
        updateData.location_tracking_enabled = location_tracking_enabled;
      }

      let effectiveLocationIds: string[] | undefined =
        location_ids !== undefined
          ? uniqueIds(location_ids)
          : location_id !== undefined
            ? location_id
              ? [location_id]
              : []
            : undefined;

      if (effectiveLocationIds === undefined && location) {
        effectiveLocationIds = normalizeDepartmentLocationIds(department as any);
      }

      if (effectiveLocationIds && effectiveLocationIds.length > 0) {
        const existingLocations = await OfficeLocation.query(trx)
          .where('org_id', org_id)
          .whereIn('id', effectiveLocationIds)
          .select('id');
        if (existingLocations.length !== effectiveLocationIds.length) {
          await trx.rollback();
          return res.status(400).json({ message: 'Invalid location_ids' });
        }
      }

      if (location) {
        const createdLocation = await OfficeLocation.query(trx).insert({
          org_id,
          name: location.name,
          latitude: location.latitude,
          longitude: location.longitude,
          radius_meters: location.radius_meters,
        } as any);
        effectiveLocationIds = uniqueIds([...(effectiveLocationIds ?? []), createdLocation.id]);
      }

      if (effectiveLocationIds !== undefined) {
        updateData.location_ids = effectiveLocationIds.length > 0 ? effectiveLocationIds : null;
        updateData.location_id = effectiveLocationIds[0] ?? null;
      }

      let effectiveShiftIds: string[] | undefined =
        work_shift_ids !== undefined
          ? uniqueIds(work_shift_ids)
          : default_shift_id !== undefined
            ? default_shift_id
              ? [default_shift_id]
              : []
            : undefined;

      if (effectiveShiftIds === undefined && default_shift) {
        effectiveShiftIds = normalizeDepartmentShiftIds(department as any);
      }

      if (effectiveShiftIds && effectiveShiftIds.length > 0) {
        const existingShifts = await WorkShift.query(trx)
          .where('org_id', org_id)
          .whereIn('id', effectiveShiftIds)
          .select('id');
        if (existingShifts.length !== effectiveShiftIds.length) {
          await trx.rollback();
          return res.status(400).json({ message: 'Invalid work_shift_ids' });
        }
      }

      if (default_shift) {
        const createdShift = await WorkShift.query(trx).insert({
          org_id,
          name: default_shift.name,
          start_time: default_shift.start_time,
          end_time: default_shift.end_time,
          break_start_time: default_shift.break_start_time,
          break_end_time: default_shift.break_end_time,
          break_duration_mins: default_shift.break_duration_mins,
        } as any);
        effectiveShiftIds = uniqueIds([...(effectiveShiftIds ?? []), createdShift.id]);
      }

      if (effectiveShiftIds !== undefined) {
        updateData.work_shift_ids = effectiveShiftIds.length > 0 ? effectiveShiftIds : null;
        updateData.default_shift_id = effectiveShiftIds[0] ?? null;
      }

      if (normalizedManagerIds !== undefined) {
        if (normalizedManagerIds.length > 0) {
          const managers = await User.query(trx)
            .whereIn('id', normalizedManagerIds)
            .where({ org_id })
            .whereNull('deleted_at');

          if (managers.length !== normalizedManagerIds.length) {
            await trx.rollback();
            return res.status(400).json({ message: 'Invalid manager_ids' });
          }

          if (managers.some((manager) => manager.status !== 'ACTIVE')) {
            await trx.rollback();
            return res.status(400).json({ message: 'All managers must be ACTIVE' });
          }

          await User.query(trx).patch({ department_id: id }).whereIn('id', normalizedManagerIds);
        }

        await DepartmentManager.query(trx).delete().where('department_id', id);
        if (normalizedManagerIds.length > 0) {
          await DepartmentManager.query(trx).insert(
            normalizedManagerIds.map((managerUserId) => ({
              department_id: id,
              manager_id: managerUserId,
            })),
          );
        }

        updateData.manager_id = normalizedManagerIds[0] ?? null;
      }

      if (employee_ids !== undefined) {
        const targetIds = employee_ids ?? [];
        if (targetIds.length > 0) {
          const employees = await User.query(trx)
            .whereIn('id', targetIds)
            .where({ org_id })
            .whereNull('deleted_at');

          if (employees.length !== targetIds.length) {
            await trx.rollback();
            return res.status(400).json({ message: 'Some employees were not found' });
          }
        }

        await User.query(trx)
          .patch({ department_id: null })
          .where({ org_id, department_id: id })
          .whereNotIn('id', targetIds);

        if (targetIds.length > 0) {
          await User.query(trx).patch({ department_id: id }).whereIn('id', targetIds);
        }
      }

      await Department.query(trx).patchAndFetchById(id, updateData);
      await trx.commit();

      if (
        location_tracking_enabled !== undefined &&
        previousLocationTrackingEnabled !== location_tracking_enabled
      ) {
        await invalidateTenantSessionsForDepartment(org_id, id);
      }

      const full = await Department.query()
        .findById(id)
        .withGraphFetched('[location, defaultShift, manager, managers, users]')
        .modifyGraph('managers', (builder) => {
          builder.select(
            'id',
            'first_name',
            'last_name',
            'profile_image_url',
            'official_email',
            'role',
            'status',
          );
        });
      if (full) {
        await mergeManagersFromDepartmentUserAssignment(
          [full],
          org_id,
          'detail',
          await isKycFlowEnabledForOrg(org_id),
        );
      }
      const [payload] = await withAssignmentCollections([withManagerIds(full)], org_id);
      return res.json(payload);
    } catch (err) {
      await trx.rollback();
      throw err;
    }
  }
  static async delete(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    const org_id = req.user.org_id;

    const department = await Department.query().where({ id, org_id }).first();

    if (!department) {
      return res.status(404).json({ message: 'Department not found' });
    }

    const trx = await Department.startTransaction();
    try {
      await User.query(trx).patch({ department_id: null }).where({ org_id, department_id: id });

      await Department.query(trx).deleteById(id);

      await trx.commit();
      return res.status(200).json({ message: 'Department deleted successfully' });
    } catch (err) {
      await trx.rollback();
      throw err;
    }
  }

  static async updateManager(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    const parsed = updateDepartmentManagerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const department = await Department.query()
      .where('id', id)
      .where('org_id', req.user.org_id)
      .first();

    if (!department) {
      return res.status(404).json({ message: 'Department not found' });
    }

    const managerIds =
      parsed.data.manager_ids !== undefined
        ? Array.from(new Set(parsed.data.manager_ids))
        : parsed.data.manager_id
          ? [parsed.data.manager_id]
          : [];

    if (managerIds.length > 0) {
      const managers = await User.query()
        .whereIn('id', managerIds)
        .where('org_id', req.user.org_id)
        .whereNull('deleted_at');

      if (managers.length !== managerIds.length) {
        return res.status(400).json({ message: 'Invalid manager_ids' });
      }
      if (managers.some((manager) => manager.status !== 'ACTIVE')) {
        return res.status(400).json({ message: 'All managers must be ACTIVE' });
      }
      await User.query().patch({ department_id: department.id }).whereIn('id', managerIds);
    }

    await DepartmentManager.query().delete().where('department_id', id);
    if (managerIds.length > 0) {
      await DepartmentManager.query().insert(
        managerIds.map((managerUserId) => ({
          department_id: id,
          manager_id: managerUserId,
        })),
      );
    }

    await Department.query().patchAndFetchById(id, {
      manager_id: managerIds[0] ?? null,
    });

    const updated = await Department.query()
      .findById(id)
      .withGraphFetched('[location, defaultShift, manager, managers, users]')
      .modifyGraph('managers', (builder) => {
        builder.select(
          'id',
          'first_name',
          'last_name',
          'profile_image_url',
          'official_email',
          'role',
          'status',
        );
      });
    if (updated) {
      await mergeManagersFromDepartmentUserAssignment(
        [updated],
        req.user.org_id,
        'detail',
        await isKycFlowEnabledForOrg(req.user.org_id),
      );
    }
    const [payload] = await withAssignmentCollections([withManagerIds(updated)], req.user.org_id);
    return res.json(payload);
  }

  static async assignEmployees(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    const parsed = assignDepartmentEmployeesSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const department = await Department.query()
      .where('id', id)
      .where('org_id', req.user.org_id)
      .first();

    if (!department) {
      return res.status(404).json({ message: 'Department not found' });
    }

    const { employee_ids } = parsed.data;

    const employees = await User.query()
      .whereIn('id', employee_ids)
      .where('org_id', req.user.org_id)
      .whereNull('deleted_at');

    if (employees.length !== employee_ids.length) {
      const foundIds = new Set(employees.map((u) => u.id));
      const missing = employee_ids.filter((empId) => !foundIds.has(empId));

      return res.status(400).json({
        message: 'Some employees were not found in this organization',
        missing_employee_ids: missing,
      });
    }

    await User.query().patch({ department_id: department.id }).whereIn('id', employee_ids);

    const updatedEmployees = await User.query()
      .whereIn('id', employee_ids)
      .select(
        'id',
        'employee_id',
        'first_name',
        'last_name',
        'official_email',
        'role',
        'status',
        'department_id',
      );

    return res.json({
      department_id: department.id,
      assigned_count: updatedEmployees.length,
      employees: updatedEmployees,
    });
  }

  static async getStatistics(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = departmentStatisticsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const org_id = req.user.org_id;
    const isManager = req.user.role === 'manager';
    const { month, year, role, status, include_unassigned, include_empty } = parsed.data;
    const kycFlowEnabled = await isKycFlowEnabledForOrg(org_id);
    const now = new Date();
    const effectiveYear = year ?? now.getUTCFullYear();
    const effectiveMonth = month ?? now.getUTCMonth() + 1;
    const periodEndDate = new Date(Date.UTC(effectiveYear, effectiveMonth, 0, 23, 59, 59, 999));
    const periodEndStr = periodEndDate.toISOString().slice(0, 10);

    let managedDepartmentIds: string[] = [];
    if (isManager) {
      managedDepartmentIds = await getManagedDepartmentIds(org_id, req.user.id);
    }

    // Base user query (scoped to org, excluding soft-deleted)
    const baseUserQuery = () => {
      let q = User.query()
        .where('users.org_id', org_id)
        .whereIn('users.role', ORG_USER_ROLES)
        .whereIn('users.status', REAL_EMPLOYEE_STATUSES as readonly string[])
        .where((qb) => {
          qb.whereNull('users.deleted_at').orWhere('users.deleted_at', '>', periodEndDate);
        })
        .whereRaw('COALESCE(users.date_of_joining::date, users.created_at::date) <= ?::date', [
          periodEndStr,
        ]);
      if (kycFlowEnabled) {
        q = applyExcludeInProgressOnboardingFilter(q, 'users');
      }
      if (isManager) {
        q = q.whereIn('users.department_id', managedDepartmentIds).where('users.role', 'employee');
      }
      if (role) q = q.where('users.role', role);
      if (status !== 'ALL') q = q.where('users.status', status);
      return q;
    };

    // Fetch org departments (for stable names + include_empty support)
    const departments = await Department.query()
      .where('org_id', org_id)
      .modify((qb) => {
        if (isManager) {
          qb.whereIn('id', managedDepartmentIds);
        }
      })
      .select('id', 'name')
      .orderBy('name', 'asc');

    // Counts grouped by department_id
    const countsByDept = await baseUserQuery()
      .whereNotNull('users.department_id')
      .select('users.department_id')
      .count('* as count')
      .groupBy('users.department_id');

    const countMap = new Map<string, number>();
    for (const row of countsByDept as unknown as Array<{
      department_id: string;
      count: string | number;
    }>) {
      countMap.set(row.department_id, Number(row.count ?? 0));
    }

    // Optional "Unassigned" bucket
    let unassignedCount = 0;
    if (include_unassigned && !isManager) {
      const unassigned = await baseUserQuery()
        .whereNull('users.department_id')
        .count('* as count')
        .first();
      unassignedCount = Number((unassigned as unknown as { count?: string | number })?.count ?? 0);
    }

    const totalUsers = Array.from(countMap.values()).reduce((a, b) => a + b, 0) + unassignedCount;

    const departmentStats = departments
      .map((d) => {
        const user_count = countMap.get(d.id) ?? 0;
        return {
          department_id: d.id,
          department_name: d.name,
          user_count,
          percentage: 0,
        };
      })
      .filter((d) => (include_empty ? true : d.user_count > 0));

    const unassigned = include_unassigned
      ? {
          department_id: null,
          department_name: 'Unassigned',
          user_count: unassignedCount,
          percentage: 0,
        }
      : null;

    // Percentages: round to 2 decimals and ensure sum is exactly 100.00 when totalUsers > 0
    const round2 = (n: number) => Math.round(n * 100) / 100;
    if (totalUsers > 0) {
      const buckets: Array<{ percentage: number; user_count: number }> = [
        ...departmentStats,
        ...(unassigned ? [unassigned] : []),
      ];

      if (buckets.length > 0) {
        let running = 0;
        for (let i = 0; i < buckets.length; i++) {
          const raw = (buckets[i].user_count / totalUsers) * 100;
          if (i === buckets.length - 1) {
            // absorb rounding drift in the last bucket
            let last = round2(100 - running);
            // guard against tiny floating/rounding artifacts
            if (Object.is(last, -0)) last = 0;
            buckets[i].percentage = Math.max(0, Math.min(100, last));
          } else {
            const p = round2(raw);
            buckets[i].percentage = p;
            running = round2(running + p);
          }
        }
      }
    } else {
      // totalUsers === 0 -> keep all percentages at 0
      for (const d of departmentStats) d.percentage = 0;
      if (unassigned) unassigned.percentage = 0;
    }

    return res.json({
      total_users: totalUsers,
      filter: {
        month: effectiveMonth,
        year: effectiveYear,
        role: role ?? null,
        status,
        include_unassigned,
        include_empty,
      },
      departments: departmentStats,
      unassigned,
    });
  }

  static async dashboard(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = departmentDashboardQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const org_id = req.user.org_id;
    const kycFlowEnabled = await isKycFlowEnabledForOrg(org_id);
    const {
      month: inputMonth,
      year: inputYear,
      role,
      status,
      include_unassigned,
      include_empty,
    } = parsed.data;

    // Determine current and previous periods (month/year)
    const now = new Date();
    const currentYear = inputYear ?? now.getUTCFullYear();
    const currentMonth = inputMonth ?? now.getUTCMonth() + 1; // 1-12

    const firstDayOfMonth = new Date(Date.UTC(currentYear, currentMonth - 1, 1));
    const lastDayOfMonth = new Date(Date.UTC(currentYear, currentMonth, 0, 23, 59, 59, 999));

    const prevMonthDate = new Date(Date.UTC(currentYear, currentMonth - 2, 1));
    const prevYear = prevMonthDate.getUTCFullYear();
    const prevMonth = prevMonthDate.getUTCMonth() + 1;
    const firstDayOfPrevMonth = new Date(Date.UTC(prevYear, prevMonth - 1, 1));
    const lastDayOfPrevMonth = new Date(Date.UTC(prevYear, prevMonth, 0, 23, 59, 59, 999));

    // Department stats
    const buildDeptBase = () => Department.query().where('org_id', org_id);

    const [totalNowRow, totalPrevRow, newThisRow, newPrevRow, closedThisRow, closedPrevRow] =
      await Promise.all([
        // Total active departments now
        buildDeptBase().whereNull('deleted_at').count('* as count').first(),
        // Total departments at end of previous month (active as of then)
        buildDeptBase()
          .where('created_at', '<=', lastDayOfPrevMonth)
          .where((qb) => {
            qb.whereNull('deleted_at').orWhere('deleted_at', '>', lastDayOfPrevMonth);
          })
          .count('* as count')
          .first(),
        // New departments this month
        buildDeptBase()
          .whereBetween('created_at', [firstDayOfMonth, lastDayOfMonth])
          .count('* as count')
          .first(),
        // New departments previous month
        buildDeptBase()
          .whereBetween('created_at', [firstDayOfPrevMonth, lastDayOfPrevMonth])
          .count('* as count')
          .first(),
        // Closed (soft-deleted) departments this month
        buildDeptBase()
          .whereBetween('deleted_at', [firstDayOfMonth, lastDayOfMonth])
          .count('* as count')
          .first(),
        // Closed previous month
        buildDeptBase()
          .whereBetween('deleted_at', [firstDayOfPrevMonth, lastDayOfPrevMonth])
          .count('* as count')
          .first(),
      ]);

    const total_departments = Number(
      (totalNowRow as unknown as { count?: string | number })?.count ?? 0,
    );
    const total_departments_prev = Number(
      (totalPrevRow as unknown as { count?: string | number })?.count ?? 0,
    );
    const new_departments_this_month = Number(
      (newThisRow as unknown as { count?: string | number })?.count ?? 0,
    );
    const new_departments_prev = Number(
      (newPrevRow as unknown as { count?: string | number })?.count ?? 0,
    );
    const closed_departments_this_month = Number(
      (closedThisRow as unknown as { count?: string | number })?.count ?? 0,
    );
    const closed_departments_prev = Number(
      (closedPrevRow as unknown as { count?: string | number })?.count ?? 0,
    );

    const pctChange = (current: number, prev: number): number | null => {
      if (prev === 0) return current === 0 ? 0 : null;
      return Math.round(((current - prev) / prev) * 100 * 100) / 100;
    };

    const total_departments_change_pct_from_last_month = pctChange(
      total_departments,
      total_departments_prev,
    );
    const new_departments_change_pct_from_last_month = pctChange(
      new_departments_this_month,
      new_departments_prev,
    );
    const closed_departments_change_pct_from_last_month = pctChange(
      closed_departments_this_month,
      closed_departments_prev,
    );

    // Turnover rate - reuse user statistics style for consistency
    const buildUserBase = () => {
      let query = User.query().where('org_id', org_id).whereNull('deleted_at');
      query = applyKycVerifiedFilter(query, 'users', kycFlowEnabled);
      if (role) {
        query = query.where('role', role);
      }
      return query;
    };

    const buildResignedUserBase = () => {
      let query = User.query().where('org_id', org_id);
      query = applyKycVerifiedFilter(query, 'users', kycFlowEnabled);
      if (role) {
        query = query.where('role', role);
      }
      return query;
    };

    const [totalUsersNowRow, resignedUsersThisRow, totalUsersPrevRow, resignedUsersPrevRow] =
      await Promise.all([
        buildUserBase().count('* as count').first(),
        applyResignedUsersInPeriodFilter(
          buildResignedUserBase(),
          org_id,
          firstDayOfMonth,
          lastDayOfMonth,
        )
          .count('* as count')
          .first(),
        // Total users at end of previous month
        (() => {
          let q = User.query().where('org_id', org_id);
          if (kycFlowEnabled) {
            q = applyExcludeInProgressOnboardingFilter(q, 'users');
          }
          if (role) q = q.where('role', role);
          return q
            .where('created_at', '<=', lastDayOfPrevMonth)
            .where((b) => {
              b.whereNull('deleted_at').orWhere('deleted_at', '>', lastDayOfPrevMonth);
            })
            .count('* as count')
            .first();
        })(),
        applyResignedUsersInPeriodFilter(
          buildResignedUserBase(),
          org_id,
          firstDayOfPrevMonth,
          lastDayOfPrevMonth,
        )
          .count('* as count')
          .first(),
      ]);

    const totalUsersNow = Number(
      (totalUsersNowRow as unknown as { count?: string | number })?.count ?? 0,
    );
    const resignedUsersThis = Number(
      (resignedUsersThisRow as unknown as { count?: string | number })?.count ?? 0,
    );
    const totalUsersPrev = Number(
      (totalUsersPrevRow as unknown as { count?: string | number })?.count ?? 0,
    );
    const resignedUsersPrev = Number(
      (resignedUsersPrevRow as unknown as { count?: string | number })?.count ?? 0,
    );

    let turnover_rate = 0;
    if (totalUsersNow > 0) {
      turnover_rate = Math.round((resignedUsersThis / totalUsersNow) * 100 * 100) / 100;
    }

    let turnover_rate_prev = 0;
    if (totalUsersPrev > 0) {
      turnover_rate_prev = Math.round((resignedUsersPrev / totalUsersPrev) * 100 * 100) / 100;
    }

    const turnover_rate_change_pct_from_last_month = pctChange(turnover_rate, turnover_rate_prev);

    // Department distribution (same semantics as /departments/statistics)
    // Include both users with department_id and managers linked via department_managers (count distinct per department)
    const departments = await Department.query()
      .where('org_id', org_id)
      .select('id', 'name')
      .orderBy('name', 'asc');

    const knex = Department.knex();
    const firstPart = knex
      .select('u.id as user_id', 'u.department_id')
      .from('users as u')
      .innerJoin('user_onboardings as uo', 'uo.user_id', 'u.id')
      .where('u.org_id', org_id)
      .whereIn('u.status', REAL_EMPLOYEE_STATUSES as readonly string[])
      .modify((qb: any) => {
        if (kycFlowEnabled) {
          qb.where((w: any) => {
            w.where('uo.kyc_status', 'VERIFIED').orWhere('uo.kyc_gating_exempt', true);
          }).whereNot('uo.onboarding_status', 'IN_PROGRESS');
        }
      })
      .whereNull('u.deleted_at')
      .whereNotNull('u.department_id');
    if (role) (firstPart as any).where('u.role', role);
    if (status !== 'ALL') (firstPart as any).where('u.status', status);

    const secondPart = knex
      .select('u.id as user_id', 'dm.department_id')
      .from('department_managers as dm')
      .innerJoin('departments as d', 'd.id', 'dm.department_id')
      .innerJoin('users as u', 'u.id', 'dm.manager_id')
      .innerJoin('user_onboardings as uo', 'uo.user_id', 'u.id')
      .where('d.org_id', org_id)
      .where('u.org_id', org_id)
      .whereIn('u.status', REAL_EMPLOYEE_STATUSES as readonly string[])
      .modify((qb: any) => {
        if (kycFlowEnabled) {
          qb.where((w: any) => {
            w.where('uo.kyc_status', 'VERIFIED').orWhere('uo.kyc_gating_exempt', true);
          }).whereNot('uo.onboarding_status', 'IN_PROGRESS');
        }
      })
      .whereNull('u.deleted_at');
    if (role) (secondPart as any).where('u.role', role);
    if (status !== 'ALL') (secondPart as any).where('u.status', status);

    const combined = firstPart.union(secondPart).as('combined');
    const countsByDept = await knex
      .select('combined.department_id')
      .countDistinct('combined.user_id as count')
      .from(combined)
      .groupBy('combined.department_id');

    const countMap = new Map<string, number>();
    for (const row of countsByDept as unknown as Array<{
      department_id: string;
      count: string | number;
    }>) {
      countMap.set(row.department_id, Number(row.count ?? 0));
    }

    let unassignedCount = 0;
    if (include_unassigned) {
      const unassignedSub = knex
        .select('u.id')
        .from('users as u')
        .innerJoin('user_onboardings as uo', 'uo.user_id', 'u.id')
        .where('u.org_id', org_id)
        .whereIn('u.status', REAL_EMPLOYEE_STATUSES as readonly string[])
        .modify((qb: any) => {
          if (kycFlowEnabled) {
            qb.where((w: any) => {
              w.where('uo.kyc_status', 'VERIFIED').orWhere('uo.kyc_gating_exempt', true);
            }).whereNot('uo.onboarding_status', 'IN_PROGRESS');
          }
        })
        .whereNull('u.department_id');
      if (role) (unassignedSub as any).where('u.role', role);
      if (status !== 'ALL') (unassignedSub as any).where('u.status', status);
      const managerIdsInOrg = knex
        .select('dm.manager_id')
        .from('department_managers as dm')
        .innerJoin('departments as d', 'd.id', 'dm.department_id')
        .where('d.org_id', org_id);
      const unassignedRow = await unassignedSub
        .whereNotIn('u.id', managerIdsInOrg)
        .count('* as count')
        .first();
      unassignedCount = Number(
        (unassignedRow as unknown as { count?: string | number })?.count ?? 0,
      );
    }

    const totalUsersForDistribution =
      Array.from(countMap.values()).reduce((a, b) => a + b, 0) + unassignedCount;

    const departmentStats = departments
      .map((d) => {
        const user_count = countMap.get(d.id) ?? 0;
        return {
          department_id: d.id,
          department_name: d.name,
          user_count,
          percentage: 0,
        };
      })
      .filter((d) => (include_empty ? true : d.user_count > 0));

    const unassignedBucket = include_unassigned
      ? {
          department_id: null as string | null,
          department_name: 'Unassigned',
          user_count: unassignedCount,
          percentage: 0,
        }
      : null;

    if (totalUsersForDistribution > 0) {
      const buckets: Array<{ percentage: number; user_count: number }> = [
        ...departmentStats,
        ...(unassignedBucket ? [unassignedBucket] : []),
      ];

      if (buckets.length > 0) {
        let running = 0;
        for (let i = 0; i < buckets.length; i += 1) {
          const raw = (buckets[i].user_count / totalUsersForDistribution) * 100;
          if (i === buckets.length - 1) {
            let last = Math.round((100 - running) * 100) / 100;
            if (Object.is(last, -0)) last = 0;
            buckets[i].percentage = Math.max(0, Math.min(100, last));
          } else {
            const p = Math.round(raw * 100) / 100;
            buckets[i].percentage = p;
            running = Math.round((running + p) * 100) / 100;
          }
        }
      }
    } else {
      for (const d of departmentStats) d.percentage = 0;
      if (unassignedBucket) unassignedBucket.percentage = 0;
    }

    return res.json({
      summary: {
        total_departments,
        total_departments_change_pct_from_last_month,
        new_departments_this_month,
        new_departments_change_pct_from_last_month,
        closed_departments_this_month,
        closed_departments_change_pct_from_last_month,
        turnover_rate,
        turnover_rate_change_pct_from_last_month,
      },
      distribution: {
        total_users: totalUsersForDistribution,
        departments: departmentStats,
        unassigned: unassignedBucket,
      },
      period: {
        month: currentMonth,
        year: currentYear,
        start_date: firstDayOfMonth.toISOString().slice(0, 10),
        end_date: lastDayOfMonth.toISOString().slice(0, 10),
      },
      compare_period: {
        month: prevMonth,
        year: prevYear,
        start_date: firstDayOfPrevMonth.toISOString().slice(0, 10),
        end_date: lastDayOfPrevMonth.toISOString().slice(0, 10),
      },
      filter: {
        role: role ?? null,
        status,
        include_unassigned,
        include_empty,
      },
    });
  }

  // Department Employee Summary (Upper Cards) - Dashboard summary cards for a specific department
  static async getEmployeeSummary(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id: department_id } = req.params;
    const org_id = req.user.org_id;
    const kycFlowEnabled = await isKycFlowEnabledForOrg(org_id);

    // Note: no extra diagnostic queries here; keep this endpoint focused on response payload.

    // Validate department exists and belongs to org
    const department = await Department.query()
      .where('id', department_id)
      .where('org_id', org_id)
      .withGraphFetched('managers')
      .first();

    if (!department) {
      return res.status(404).json({ message: 'Department not found' });
    }

    // Get current date info (using UTC to avoid timezone issues)
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth() + 1; // 1-12

    // Calculate first and last day of current month (UTC)
    const firstDayOfMonth = new Date(Date.UTC(currentYear, currentMonth - 1, 1));
    const lastDayOfMonth = new Date(Date.UTC(currentYear, currentMonth, 0, 23, 59, 59, 999));

    // Calculate first and last day of previous month (UTC)
    const prevMonthDate = new Date(Date.UTC(currentYear, currentMonth - 2, 1));
    const prevYear = prevMonthDate.getUTCFullYear();
    const prevMonth = prevMonthDate.getUTCMonth() + 1; // 1-12
    const firstDayOfPrevMonth = new Date(Date.UTC(prevYear, prevMonth - 1, 1));
    const lastDayOfPrevMonth = new Date(Date.UTC(prevYear, prevMonth, 0, 23, 59, 59, 999));

    // Build base query for employees in this department (roles = 'employee' or 'hr', ACTIVE, VERIFIED KYC)
    const buildEmployeeQuery = () => {
      const query = User.query()
        .where('org_id', org_id)
        .whereIn('role', ['employee', 'hr'])
        .where('status', 'ACTIVE')
        .where('department_id', department_id)
        .whereNull('deleted_at');
      applyKycVerifiedFilter(query, 'users', kycFlowEnabled);
      return query;
    };

    const managers: Array<{ id: string; full_name: string; profile_image_url: string | null }> = (
      await applyKycVerifiedFilter(
        User.query()
          .where('org_id', org_id)
          .where('role', 'manager')
          .where('status', 'ACTIVE')
          .where((qb) => {
            qb.where('department_id', department_id).orWhereIn(
              'id',
              DepartmentManager.query().select('manager_id').where('department_id', department_id),
            );
          })
          .whereNull('deleted_at'),
        'users',
        kycFlowEnabled,
      ).select('id', 'first_name', 'last_name', 'profile_image_url')
    ).map((manager: Pick<User, 'id' | 'first_name' | 'last_name' | 'profile_image_url'>) => ({
      id: manager.id,
      full_name: `${manager.first_name ?? ''} ${manager.last_name ?? ''}`.trim(),
      profile_image_url: manager.profile_image_url ?? null,
    }));
    const managerIds = managers.map((manager) => manager.id);
    const managerCount = managerIds.length;

    // Run queries in parallel
    const [
      totalEmployeesResult,
      newEmployeesThisMonthResult,
      totalEmployeesPrevMonthResult,
      newEmployeesPrevMonthResult,
    ] = await Promise.all([
      // Total employees now
      buildEmployeeQuery().count('* as count').first(),
      // New employees this month
      buildEmployeeQuery()
        .whereBetween('created_at', [firstDayOfMonth, lastDayOfMonth])
        .count('* as count')
        .first(),
      // Total employees at end of previous month
      buildEmployeeQuery()
        .where('created_at', '<=', lastDayOfPrevMonth)
        .where((b) => {
          b.whereNull('deleted_at').orWhere('deleted_at', '>', lastDayOfPrevMonth);
        })
        .count('* as count')
        .first(),
      // New employees in previous month
      buildEmployeeQuery()
        .whereBetween('created_at', [firstDayOfPrevMonth, lastDayOfPrevMonth])
        .count('* as count')
        .first(),
    ]);

    // Extract counts and include managers in headcount (align with list API)
    const totalEmployees =
      Number((totalEmployeesResult as unknown as { count?: string | number })?.count ?? 0) +
      managerCount;
    const newEmployeesThisMonth =
      Number((newEmployeesThisMonthResult as unknown as { count?: string | number })?.count ?? 0) +
      managerCount;
    const totalEmployeesPrevMonth =
      Number(
        (totalEmployeesPrevMonthResult as unknown as { count?: string | number })?.count ?? 0,
      ) + managerCount;
    const newEmployeesPrevMonth =
      Number((newEmployeesPrevMonthResult as unknown as { count?: string | number })?.count ?? 0) +
      managerCount;

    // Calculate percentage changes
    const totalEmployeesChangePct =
      totalEmployeesPrevMonth > 0
        ? ((totalEmployees - totalEmployeesPrevMonth) / totalEmployeesPrevMonth) * 100
        : 0;
    const newEmployeesChangePct =
      newEmployeesPrevMonth > 0
        ? ((newEmployeesThisMonth - newEmployeesPrevMonth) / newEmployeesPrevMonth) * 100
        : newEmployeesThisMonth > 0
          ? 100
          : 0;

    return res.json({
      department: { id: department.id, name: department.name },
      managers,
      manager_ids: managerIds,
      total_employees: {
        count: totalEmployees,
        change_percentage: totalEmployeesChangePct,
        change_display:
          totalEmployeesChangePct >= 0
            ? `+${totalEmployeesChangePct.toFixed(1)}%`
            : `${totalEmployeesChangePct.toFixed(1)}%`,
      },
      new_employees_this_month: {
        count: newEmployeesThisMonth,
        change_percentage: newEmployeesChangePct,
        change_display:
          newEmployeesChangePct >= 0
            ? `+${newEmployeesChangePct.toFixed(1)}%`
            : `${newEmployeesChangePct.toFixed(1)}%`,
      },
    });
  }

  // Department Employee List (Lower Table) - Paginated employee list for a specific department
  static async getEmployeeList(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id: department_id } = req.params;
    const parsed = departmentEmployeeListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { page, limit, status, employment_type, work_mode, search, sort_by, sort_dir } =
      parsed.data;

    const org_id = req.user.org_id;
    const kycFlowEnabled = await isKycFlowEnabledForOrg(org_id);

    // Note: no extra diagnostic queries here; keep this endpoint focused on response payload.

    // Validate department exists and belongs to org
    const department = await Department.query()
      .where('id', department_id)
      .where('org_id', org_id)
      .first();

    if (!department) {
      return res.status(404).json({ message: 'Department not found' });
    }

    // Base query for users in this department (role = 'employee', 'hr' or 'manager', not soft-deleted)
    // Employees are linked via department_id, managers can be linked via department_id OR department_managers table
    const baseQuery = User.query()
      .alias('u')
      .leftJoin('employee_employment_details as eed', 'eed.user_id', 'u.id')
      .leftJoin('department_managers as dm', 'dm.manager_id', 'u.id')
      .innerJoin('user_onboardings as uo', 'uo.user_id', 'u.id')
      .where('u.org_id', org_id)
      .whereIn('u.role', ['employee', 'hr', 'manager'])
      .whereIn('u.status', REAL_EMPLOYEE_STATUSES as readonly string[])
      .modify((qb: any) => {
        if (kycFlowEnabled) {
          qb.where((w: any) => {
            w.where('uo.kyc_status', 'VERIFIED').orWhere('uo.kyc_gating_exempt', true);
          }).whereNot('uo.onboarding_status', 'IN_PROGRESS');
        }
      })
      .where((qb) => {
        qb.where('u.department_id', department_id).orWhere('dm.department_id', department_id);
      })
      .whereNull('u.deleted_at');

    // Filters
    // Handle "ALL" status bypass
    if (status && status !== 'ALL') {
      baseQuery.where('u.status', status);
    }

    if (employment_type) {
      baseQuery.where('eed.employment_type', employment_type);
    }

    if (work_mode) {
      baseQuery.where('eed.work_mode', work_mode);
    }

    // Search
    if (search) {
      const term = `%${search}%`;
      baseQuery.where((qb) => {
        qb.where('u.employee_id', 'ilike', term)
          .orWhere('u.first_name', 'ilike', term)
          .orWhere('u.last_name', 'ilike', term)
          .orWhere('u.official_email', 'ilike', term)
          .orWhereRaw("concat(u.first_name, ' ', u.last_name) ilike ?", [term]);
      });
    }

    // Pagination stats
    const countRow = await baseQuery.clone().countDistinct('u.id as count').first();
    const total = Number((countRow as { count?: string | number } | undefined)?.count ?? 0);
    const total_pages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(Math.max(page, 1), total_pages);
    const offset = (safePage - 1) * limit;

    // Sorting
    if (sort_by === 'JOIN_DATE') {
      baseQuery.orderBy('u.date_of_joining', sort_dir === 'DESC' ? 'desc' : 'asc');
    } else if (sort_by === 'STATUS') {
      baseQuery.orderBy('u.status', sort_dir === 'DESC' ? 'desc' : 'asc');
    } else if (sort_by === 'EMPLOYMENT_TYPE') {
      baseQuery.orderBy('eed.employment_type', sort_dir === 'DESC' ? 'desc' : 'asc');
    } else if (sort_by === 'WORK_MODE') {
      baseQuery.orderBy('eed.work_mode', sort_dir === 'DESC' ? 'desc' : 'asc');
    } else {
      // Default: NAME
      baseQuery.orderBy([
        { column: 'u.first_name', order: sort_dir === 'DESC' ? 'desc' : 'asc' },
        { column: 'u.last_name', order: sort_dir === 'DESC' ? 'desc' : 'asc' },
      ]);
    }

    // Secondary sort for consistency
    baseQuery.orderBy('u.created_at', 'desc');

    // Fetch data - use GROUP BY to prevent duplicates from LEFT JOIN with department_managers
    const rows = await baseQuery
      .clone()
      .select(
        'u.id',
        'u.employee_id',
        'u.first_name',
        'u.last_name',
        'u.role',
        'u.designation',
        'u.date_of_joining',
        'u.status',
        'u.profile_image_url',
        'eed.employment_type',
        'eed.work_mode',
      )
      .groupBy(
        'u.id',
        'u.employee_id',
        'u.first_name',
        'u.last_name',
        'u.role',
        'u.designation',
        'u.date_of_joining',
        'u.status',
        'u.profile_image_url',
        'eed.employment_type',
        'eed.work_mode',
      )
      .limit(limit)
      .offset(offset);

    const data = rows.map((r: any) => ({
      id: r.id,
      employee_id: r.employee_id,
      name: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(),
      role: r.role,
      job_title: r.designation ?? null,
      employment_type: r.employment_type ?? null,
      work_mode: r.work_mode ?? null,
      join_date: r.date_of_joining ?? null,
      status: r.status,
      profile_image_url: r.profile_image_url ?? null,
      // Note: department field is omitted since all users belong to the same department
      // (specified in the URL path parameter)
    }));

    return res.json({
      page: safePage,
      limit,
      total,
      total_pages,
      data,
    });
  }
}
