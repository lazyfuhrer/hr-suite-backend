import type { Response } from 'express';
import type { Transaction } from 'objection';

import { Organization } from '../models/Organization';
import { User } from '../models/User';

export const DEFAULT_ORGANIZATION_MAX_USERS = 50;

export const ORGANIZATION_USER_LIMIT_REACHED_MESSAGE =
  'Maximum user limit reached for this organization. Please contact your administrator.';

export const ROLES_EXCLUDED_FROM_USER_LIMIT = ['admin'] as const;

export const isRoleExcludedFromUserLimit = (role: string): boolean =>
  (ROLES_EXCLUDED_FROM_USER_LIMIT as readonly string[]).includes(role);

export const countOrganizationUsersTowardLimit = async (
  orgId: string,
  trx?: Transaction,
): Promise<number> => {
  const query = User.query(trx)
    .where('org_id', orgId)
    .whereNot('role', 'admin')
    .whereNull('deleted_at');

  const row = await query.count('* as count').first();
  return Number((row as { count?: string | number } | undefined)?.count ?? 0);
};

export const getOrganizationUserLimitDenialMessage = async (
  orgId: string,
  role: string,
  trx?: Transaction,
): Promise<string | null> => {
  if (isRoleExcludedFromUserLimit(role)) {
    return null;
  }

  const org = await Organization.query(trx).findById(orgId).forUpdate();
  if (!org) {
    return null;
  }

  const currentCount = await countOrganizationUsersTowardLimit(orgId, trx);
  if (currentCount >= org.max_users) {
    return ORGANIZATION_USER_LIMIT_REACHED_MESSAGE;
  }

  return null;
};

export const sendOrganizationUserLimitDenied = (res: Response, message: string): boolean => {
  res.status(403).json({ message });
  return true;
};

export class OrganizationUserLimitExceededError extends Error {
  readonly statusCode = 403;

  constructor(message: string = ORGANIZATION_USER_LIMIT_REACHED_MESSAGE) {
    super(message);
    this.name = 'OrganizationUserLimitExceededError';
  }
}

export const assertOrganizationUserLimit = async (
  orgId: string,
  role: string,
  trx?: Transaction,
): Promise<void> => {
  const denial = await getOrganizationUserLimitDenialMessage(orgId, role, trx);
  if (denial) {
    throw new OrganizationUserLimitExceededError(denial);
  }
};
