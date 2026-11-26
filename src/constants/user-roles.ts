export const ORG_USER_ROLES = ['employee', 'hr', 'manager'] as const;

export type OrgUserRole = (typeof ORG_USER_ROLES)[number];
