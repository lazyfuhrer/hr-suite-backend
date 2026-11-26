import { Department } from '../models/Department';
import { User } from '../models/User';

export type LocationTrackingSource = 'user' | 'department' | 'default';

export type LocationTrackingStatus = {
  enabled: boolean;
  user_override: boolean | null;
  department_enabled: boolean | null;
  source: LocationTrackingSource;
};

type TrackingUserLike = {
  location_tracking_enabled?: boolean | null;
};

type TrackingDepartmentLike = {
  location_tracking_enabled?: boolean | null;
} | null;

/**
 * Effective tracking = user override if set, else department flag, else false.
 */
export function resolveLocationTrackingEnabled(
  user: TrackingUserLike,
  department?: TrackingDepartmentLike,
): boolean {
  if (user.location_tracking_enabled === true || user.location_tracking_enabled === false) {
    return user.location_tracking_enabled;
  }
  return department?.location_tracking_enabled === true;
}

export function resolveLocationTrackingStatus(
  user: TrackingUserLike,
  department?: TrackingDepartmentLike,
): LocationTrackingStatus {
  const userOverride =
    user.location_tracking_enabled === true || user.location_tracking_enabled === false
      ? user.location_tracking_enabled
      : null;
  const departmentEnabled =
    department == null ? null : department.location_tracking_enabled === true;

  if (userOverride !== null) {
    return {
      enabled: userOverride,
      user_override: userOverride,
      department_enabled: departmentEnabled,
      source: 'user',
    };
  }

  if (departmentEnabled === true) {
    return {
      enabled: true,
      user_override: null,
      department_enabled: true,
      source: 'department',
    };
  }

  return {
    enabled: false,
    user_override: null,
    department_enabled: departmentEnabled,
    source: department == null ? 'default' : 'department',
  };
}

export async function getLocationTrackingStatus(
  orgId: string,
  userId: string,
): Promise<LocationTrackingStatus | null> {
  const user = await User.query()
    .select('id', 'department_id', 'location_tracking_enabled')
    .findOne({ id: userId, org_id: orgId })
    .whereNull('deleted_at');

  if (!user) {
    return null;
  }

  let department: Department | undefined;
  if (user.department_id) {
    department = await Department.query()
      .select('id', 'location_tracking_enabled')
      .findOne({ id: user.department_id, org_id: orgId })
      .whereNull('deleted_at');
  }

  return resolveLocationTrackingStatus(user, department ?? null);
}
