import type { Transaction } from 'objection';

import { User } from '../models/User';
import { normalizeOfficialEmail, SWITCHABLE_ROLES } from '../services/tenant-auth.service';

export type AdminHrCredential = {
  password_hash: string;
  must_change_password: boolean;
};

export type AdminHrSourceUser = {
  id: string;
  org_id: string;
  password_hash: string;
  must_change_password: boolean;
};

export type SyncAdminHrPasswordOptions = {
  exceptUserId?: string;
  trx?: Transaction;
};

/**
 * Find an existing admin/hr user for the same official email (any org).
 * Prefers a row that already completed password change, else the oldest account.
 */
export async function findSourceAdminHrUser(
  email: string,
  opts?: { trx?: Transaction; excludeOrgId?: string },
): Promise<AdminHrSourceUser | null> {
  const emailNormalized = normalizeOfficialEmail(email);
  const q = opts?.trx ? User.query(opts.trx) : User.query();

  let query = q
    .select('id', 'org_id', 'password_hash', 'must_change_password', 'created_at')
    .whereRaw('LOWER(TRIM(official_email)) = ?', [emailNormalized])
    .whereIn('role', [...SWITCHABLE_ROLES])
    .whereNull('deleted_at')
    .whereNotNull('password_hash');

  if (opts?.excludeOrgId) {
    query = query.whereNot('org_id', opts.excludeOrgId);
  }

  const rows = await query;

  if (!rows.length) {
    return null;
  }

  const preferred =
    rows.find((row) => row.must_change_password === false) ??
    [...rows].sort((a, b) => {
      const aTime = a.created_at ? new Date(a.created_at as unknown as string).getTime() : 0;
      const bTime = b.created_at ? new Date(b.created_at as unknown as string).getTime() : 0;
      return aTime - bTime;
    })[0];

  if (!preferred?.password_hash || !preferred.id || !preferred.org_id) {
    return null;
  }

  return {
    id: preferred.id,
    org_id: preferred.org_id,
    password_hash: preferred.password_hash,
    must_change_password: Boolean(preferred.must_change_password),
  };
}

/**
 * Find an existing admin/hr credential for the same official email (any org).
 */
export async function findExistingAdminHrCredential(
  email: string,
  opts?: { trx?: Transaction; excludeOrgId?: string },
): Promise<AdminHrCredential | null> {
  const source = await findSourceAdminHrUser(email, opts);
  if (!source) {
    return null;
  }

  return {
    password_hash: source.password_hash,
    must_change_password: source.must_change_password,
  };
}

/**
 * Patch all non-deleted admin/hr rows that share the given email with the same password fields.
 */
export async function syncAdminHrPasswordByEmail(
  email: string,
  credential: AdminHrCredential,
  opts?: SyncAdminHrPasswordOptions,
): Promise<number> {
  const emailNormalized = normalizeOfficialEmail(email);
  const q = opts?.trx ? User.query(opts.trx) : User.query();

  let query = q
    .patch({
      password_hash: credential.password_hash,
      must_change_password: credential.must_change_password,
    } as Partial<User>)
    .whereRaw('LOWER(TRIM(official_email)) = ?', [emailNormalized])
    .whereIn('role', [...SWITCHABLE_ROLES])
    .whereNull('deleted_at');

  if (opts?.exceptUserId) {
    query = query.whereNot('id', opts.exceptUserId);
  }

  return query;
}

export function isAdminOrHrRole(role: string | null | undefined): boolean {
  return role === 'admin' || role === 'hr';
}
