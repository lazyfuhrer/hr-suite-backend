import type { Request, Response } from 'express';
import bcrypt from 'bcrypt';

import { User } from '../models/User';
import { UserOnboarding } from '../models/UserOnboarding';
import { Roles } from '../models/Roles';
import { UserRole } from '../models/UserRoles';
import { Organization } from '../models/Organization';
import { generateTempPassword } from '../utils/password.util';
import { sendMsg91Email } from '../utils/msg91.utils';
import { markEmployeeWelcomeEmailSent } from '../utils/employee-welcome-email.utils';
import {
  findExistingAdminHrCredential,
  isAdminOrHrRole,
} from '../utils/cross-org-admin-hr-password.utils';
import {
  AdminHrCrossOrgEligibilityError,
  cloneAdminHrPersonDataFromEmail,
} from '../services/cross-org-admin-hr-onboarding-clone.service';
import { triggerUserKycVerification } from '../services/reverseOnboardingKycTrigger.service';
import { logger } from '../config/logger';
import { getManagedDepartmentIds } from '../utils/department-manager.utils';
import {
  assertOrganizationUserLimit,
  OrganizationUserLimitExceededError,
} from '../utils/organization-user-limit.utils';
import {
  reverseOnboardingInviteSchema,
  reverseOnboardingDraftListQuerySchema,
} from '../validators';

export class ReverseOnboardingController {
  /**
   * Admin/HR: list reverse-onboarding draft users.
   * Returns users in pre-activation states so admins can review and act.
   */
  static async listDraftUsers(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = reverseOnboardingDraftListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { page, limit, status, search, sort_dir } = parsed.data;
    const org_id = req.user.org_id;
    const draftStatuses = ['IN_PROGRESS', 'INVITED', 'REJECTED'] as const;
    const isManager = req.user.role === 'manager';
    const managedDepartmentIds = isManager
      ? await getManagedDepartmentIds(org_id, req.user.id)
      : [];

    const baseQuery = User.query()
      .alias('u')
      .leftJoin('departments as d', 'd.id', 'u.department_id')
      .leftJoin('user_onboardings as uo', 'uo.user_id', 'u.id')
      .where('u.org_id', org_id)
      .whereIn('u.status', draftStatuses as readonly string[])
      .where('uo.kyc_status', 'PENDING')
      .whereNull('u.deleted_at');
    if (isManager) {
      if (managedDepartmentIds.length === 0) {
        return res.json({ page: 1, limit, total: 0, total_pages: 1, data: [] });
      }
      baseQuery.whereIn('u.department_id', managedDepartmentIds);
    }

    if (status !== 'ALL') {
      baseQuery.where('u.status', status);
    }

    if (search) {
      const term = `%${search}%`;
      baseQuery.where((qb) => {
        qb.where('u.employee_id', 'ilike', term)
          .orWhere('u.first_name', 'ilike', term)
          .orWhere('u.last_name', 'ilike', term)
          .orWhere('u.official_email', 'ilike', term)
          .orWhere('d.name', 'ilike', term)
          .orWhereRaw("concat(u.first_name, ' ', u.last_name) ilike ?", [term]);
      });
    }

    const totalRow = await baseQuery.clone().countDistinct('u.id as count').first();
    const total = Number((totalRow as { count?: string | number } | undefined)?.count ?? 0);
    const total_pages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(Math.max(page, 1), total_pages);
    const offset = (safePage - 1) * limit;

    const rows = await baseQuery
      .clone()
      .select(
        'u.id',
        'u.org_id',
        'u.employee_id',
        'u.first_name',
        'u.last_name',
        'u.profile_image_url',
        'u.official_email',
        'u.role',
        'u.status',
        'u.department_id',
        'd.name as department_name',
        'u.must_change_password',
        'u.created_at',
        'u.updated_at',
        'uo.onboarding_status as onboarding_status',
        'uo.kyc_status as kyc_status',
        'uo.kyc_failure_reason as kyc_failure_reason',
      )
      .orderBy('u.created_at', sort_dir === 'ASC' ? 'asc' : 'desc')
      .limit(limit)
      .offset(offset);

    const data = rows.map((row: any) => ({
      id: row.id,
      org_id: row.org_id,
      employee_id: row.employee_id ?? null,
      first_name: row.first_name,
      last_name: row.last_name,
      full_name: `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim(),
      profile_image_url: row.profile_image_url ?? null,
      official_email: row.official_email,
      role: row.role,
      status: row.status,
      department: row.department_id
        ? {
            id: row.department_id,
            name: row.department_name,
          }
        : null,
      must_change_password: row.must_change_password,
      onboarding_status: row.onboarding_status ?? null,
      kyc_status: row.kyc_status ?? null,
      kyc_failure_reason: row.kyc_failure_reason ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));

    return res.json({
      page: safePage,
      limit,
      total,
      total_pages,
      data,
    });
  }

  /**
   * Admin/HR: create a minimal invited user record.
   * - Creates User with status=IN_PROGRESS and must_change_password=true.
   * - Creates UserOnboarding row with onboarding_status=IN_PROGRESS and kyc_status=PENDING.
   * - Sends welcome/invitation email with temp password.
   */
  static async inviteUser(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = reverseOnboardingInviteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { firstName, lastName, email, designation, role, department_id } = parsed.data;
    const org_id = req.user.org_id;
    let effectiveDepartmentId = department_id;

    if (req.user.role === 'manager') {
      const managedDepartmentIds = await getManagedDepartmentIds(org_id, req.user.id);

      if (!effectiveDepartmentId) {
      } else if (!managedDepartmentIds.includes(effectiveDepartmentId)) {
        return res.status(403).json({ message: 'Forbidden' });
      }
    }

    const existingEmail = await User.query().findOne({ org_id, official_email: email });
    if (existingEmail) {
      return res.status(409).json({ message: 'Email already exists' });
    }

    const existingCredential = isAdminOrHrRole(role)
      ? await findExistingAdminHrCredential(email, { excludeOrgId: org_id })
      : null;
    const passwordReused = Boolean(existingCredential);
    const tempPassword = passwordReused ? null : generateTempPassword();
    const password_hash = existingCredential
      ? existingCredential.password_hash
      : await bcrypt.hash(tempPassword as string, 10);
    const must_change_password = existingCredential
      ? existingCredential.must_change_password
      : true;

    let createdUser: User;
    try {
      createdUser = await User.transaction(async (trx) => {
        const roleRecord = await Roles.query(trx).where('name', role).first();

        if (!roleRecord) {
          throw new Error(`Role "${role}" not found in the database.`);
        }

        await assertOrganizationUserLimit(org_id, roleRecord.name, trx);

        const created = await User.query(trx).insert({
          org_id,
          // employee_id is intentionally left null/undefined at invite time; it will be
          // assigned later during the employment step of onboarding.
          first_name: firstName,
          last_name: lastName,
          official_email: email,
          password_hash,
          role: roleRecord.name,
          status: 'IN_PROGRESS',
          must_change_password,
          designation: designation ?? undefined,
          department_id: effectiveDepartmentId ?? undefined,
        });

        await UserRole.query(trx).insert({
          role_id: roleRecord.id,
          user_id: created.id,
        });

        await UserOnboarding.query(trx)
          .insert({
            user_id: created.id,
            onboarding_status: 'IN_PROGRESS',
            kyc_status: 'PENDING',
          } as Partial<UserOnboarding>)
          .onConflict('user_id')
          .merge();

        return created;
      });
    } catch (error) {
      if (error instanceof OrganizationUserLimitExceededError) {
        return res.status(403).json({ message: error.message });
      }
      throw error;
    }

    // Best-effort welcome/invitation email; skip when password reused from existing admin/hr.
    if (!passwordReused && tempPassword) {
      try {
        const organization = await Organization.query().findById(createdUser.org_id);
        const orgName = organization?.name ?? 'Your Organization';

        const adminUser = req.user;
        const adminName =
          (adminUser.first_name || adminUser.last_name
            ? `${adminUser.first_name} ${adminUser.last_name}`.trim()
            : 'Admin') || 'Admin';

        await sendMsg91Email({
          toEmail: createdUser.official_email,
          toName: `${createdUser.first_name} ${createdUser.last_name}`.trim(),
          templateId: 'employee_welcome_email',
          variables: {
            ORG_NAME: orgName,
            ADMIN_NAME: adminName,
            EMPLOYEE_NAME: `${createdUser.first_name} ${createdUser.last_name}`.trim(),
            LOGIN_EMAIL: createdUser.official_email,
            TEMP_PASSWORD: tempPassword,
            WEB_LOGIN_URL: process.env.WEB_LOGIN_URL ?? '',
            IOS_APP_URL: process.env.IOS_APP_URL ?? '',
            ANDROID_APP_URL: process.env.ANDROID_APP_URL ?? '',
          },
        });
        await markEmployeeWelcomeEmailSent(undefined, createdUser.id);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to send reverse-onboarding welcome email:', error);
      }
    }

    let onboardingDataCloned = false;
    if (passwordReused) {
      try {
        onboardingDataCloned = await cloneAdminHrPersonDataFromEmail({
          email,
          targetUserId: createdUser.id,
          targetOrgId: org_id,
          targetRole: isAdminOrHrRole(createdUser.role)
            ? (createdUser.role as 'admin' | 'hr')
            : undefined,
        });
      } catch (err) {
        if (err instanceof AdminHrCrossOrgEligibilityError) {
          logger.warn(
            { err, user_id: createdUser.id, org_id },
            'Skipped admin/hr onboarding clone due to eligibility gate',
          );
        } else {
          logger.warn(
            { err, user_id: createdUser.id, org_id },
            'Failed to clone admin/hr onboarding data after reverse invite',
          );
        }
      }
    }

    return res.status(201).json({
      id: createdUser.id,
      org_id: createdUser.org_id,
      first_name: createdUser.first_name,
      last_name: createdUser.last_name,
      official_email: createdUser.official_email,
      role: createdUser.role,
      status: createdUser.status,
      designation: createdUser.designation ?? null,
      kyc_status: 'PENDING',
      password_reused: passwordReused,
      onboarding_data_cloned: onboardingDataCloned,
      // Note: tempPassword is included in the response to simplify local and QA testing
      // when email delivery is not yet wired up or is flaky. Do NOT expose this field
      // in production-facing clients.
      ...(passwordReused || !tempPassword ? {} : { temp_password: tempPassword }),
    });
  }

  /**
   * Admin/HR: trigger KYC verification for a user's identity and bank details.
   * - Reads Aadhaar/PAN identities and bank details.
   * - Calls external KYC APIs via kycVerification.service.
   * - Updates UserDocument.verification_status/meta and UserOnboarding.kyc_* fields.
   * - Marks User.status = ACTIVE on success, REJECTED on failure.
   */
  static async verifyUserKyc(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { userId } = req.params as { userId?: string };
    if (!userId) {
      return res.status(400).json({ message: 'userId is required' });
    }

    const org_id = req.user.org_id;
    if (req.user.role === 'manager') {
      const target = await User.query()
        .where('id', userId)
        .where('org_id', org_id)
        .whereNull('deleted_at')
        .first();
      if (!target) {
        return res.status(404).json({ message: 'User not found' });
      }
      const managedDepartmentIds = await getManagedDepartmentIds(org_id, req.user.id);
      if (!target.department_id || !managedDepartmentIds.includes(String(target.department_id))) {
        return res.status(403).json({ message: 'Forbidden' });
      }
    }

    const onboarding = await UserOnboarding.query().findOne({ user_id: userId });

    try {
      const result = await triggerUserKycVerification(org_id, userId);
      return res.json({
        user_id: userId,
        org_id,
        kyc: {
          overall_status: result.overall_status,
          identity: result.identity,
          bank: result.bank,
        },
        user_status: result.user_status,
        onboarding_status: onboarding?.onboarding_status ?? null,
      });
    } catch (e: any) {
      return res.status(400).json({ message: e?.message ?? 'Failed to verify user KYC' });
    }
  }
}
