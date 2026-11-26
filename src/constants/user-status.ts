export const REAL_EMPLOYEE_STATUSES = ['ACTIVE', 'INACTIVE', 'ON_NOTICE'] as const;

export type RealEmployeeStatus = (typeof REAL_EMPLOYEE_STATUSES)[number];

/** Users included in admin attendance reports (excludes INACTIVE). */
export const ATTENDANCE_ACTIVE_EMPLOYEE_STATUSES = ['ACTIVE', 'ON_NOTICE'] as const;

export type AttendanceActiveEmployeeStatus = (typeof ATTENDANCE_ACTIVE_EMPLOYEE_STATUSES)[number];
