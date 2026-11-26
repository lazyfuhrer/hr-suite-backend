export const USER_EXIT_TYPES = [
  'RESIGNATION',
  'TERMINATION',
  'RETIREMENT',
  'END_OF_CONTRACT',
  'OTHER',
] as const;

export const USER_EXIT_STATUSES = ['SCHEDULED', 'ON_NOTICE', 'COMPLETED', 'CANCELLED'] as const;

export const ACTIVE_USER_EXIT_STATUSES = ['SCHEDULED', 'ON_NOTICE', 'COMPLETED'] as const;

export const EXIT_PROTECTED_ROLES = ['admin', 'device'] as const;
