import bcrypt from 'bcrypt';
import type { Transaction } from 'objection';

import { DepartmentManager } from '../models/DepartmentManager';
import { Roles } from '../models/Roles';
import { User } from '../models/User';
import { UserRole } from '../models/UserRoles';
import { generateTempPassword } from '../utils/password.util';
import {
  findExistingAdminHrCredential,
  isAdminOrHrRole,
} from '../utils/cross-org-admin-hr-password.utils';
import {
  AdminHrCrossOrgEligibilityError,
  cloneAdminHrPersonDataFromEmail,
} from './cross-org-admin-hr-onboarding-clone.service';
import { logger } from '../config/logger';
import {
  assertOrganizationUserLimit,
  OrganizationUserLimitExceededError,
} from '../utils/organization-user-limit.utils';

export interface CreateTenantUserInput {
  org_id: string;
  employee_id: string;
  first_name: string;
  last_name: string;
  official_email: string;
  role: 'admin' | 'hr' | 'manager' | 'employee';
  department_id?: string | null;
  designation?: string | null;
  date_of_joining?: string | null;
  /** When set, skips temp-password generation (cross-org admin/hr reuse). */
  password_hash?: string;
  must_change_password?: boolean;
  trx?: Transaction;
}

export interface CreateTenantUserResult {
  user: User;
  /** Null when password was reused from an existing admin/hr account. */
  tempPassword: string | null;
  passwordReused: boolean;
  onboardingDataCloned: boolean;
}

export { OrganizationUserLimitExceededError };

export async function createTenantUser(
  input: CreateTenantUserInput,
): Promise<CreateTenantUserResult> {
  const {
    org_id,
    employee_id,
    first_name,
    last_name,
    official_email,
    role,
    department_id,
    designation,
    date_of_joining,
    trx: externalTrx,
  } = input;

  let passwordReused = false;
  let password_hash = input.password_hash;
  let must_change_password = input.must_change_password ?? true;
  let tempPassword: string | null = null;

  if (!password_hash && isAdminOrHrRole(role)) {
    const existing = await findExistingAdminHrCredential(official_email, {
      trx: externalTrx,
      excludeOrgId: org_id,
    });
    if (existing) {
      password_hash = existing.password_hash;
      must_change_password = existing.must_change_password;
      passwordReused = true;
    }
  } else if (password_hash) {
    passwordReused = true;
  }

  if (!password_hash) {
    tempPassword = generateTempPassword();
    password_hash = await bcrypt.hash(tempPassword, 10);
    must_change_password = input.must_change_password ?? true;
  }

  const run = async (trx: Transaction) => {
    const roleRecord = await Roles.query(trx).where('name', role).first();

    if (!roleRecord) {
      throw new Error(`Role "${role}" not found in the database.`);
    }

    await assertOrganizationUserLimit(org_id, roleRecord.name, trx);

    const created = await User.query(trx).insert({
      org_id,
      employee_id,
      first_name,
      last_name,
      official_email,
      password_hash,
      role: roleRecord.name,
      status: 'ACTIVE',
      must_change_password,
      department_id: department_id ?? undefined,
      designation: designation ?? undefined,
      date_of_joining: date_of_joining ?? undefined,
    });

    if (created.role === 'manager' && created.department_id) {
      await DepartmentManager.query(trx)
        .insert({ department_id: String(created.department_id), manager_id: created.id } as any)
        .onConflict(['department_id', 'manager_id'])
        .ignore();
    }

    await UserRole.query(trx).insert({
      role_id: roleRecord.id,
      user_id: created.id,
    });

    return created;
  };

  const user = externalTrx ? await run(externalTrx) : await User.transaction(run);

  let onboardingDataCloned = false;
  if (passwordReused) {
    try {
      onboardingDataCloned = await cloneAdminHrPersonDataFromEmail({
        email: official_email,
        targetUserId: user.id,
        targetOrgId: org_id,
        trx: externalTrx,
        targetRole: isAdminOrHrRole(role) ? (role as 'admin' | 'hr') : undefined,
      });
    } catch (err) {
      if (err instanceof AdminHrCrossOrgEligibilityError) {
        logger.warn(
          { err, user_id: user.id, org_id, email: official_email, role },
          'Skipped admin/hr onboarding clone due to eligibility gate',
        );
      } else {
        logger.warn(
          { err, user_id: user.id, org_id, email: official_email },
          'Failed to clone admin/hr onboarding data after user create',
        );
      }
    }
  }

  return { user, tempPassword, passwordReused, onboardingDataCloned };
}
