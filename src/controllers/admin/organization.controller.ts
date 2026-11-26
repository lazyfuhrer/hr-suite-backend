import type { Request, Response } from 'express';
import bcrypt from 'bcrypt';

import { Organization } from '../../models/Organization';
import { User } from '../../models/User';
import { generateTempPassword } from '../../utils/password.util';
import { Roles } from '../../models/Roles';
import { randomBytes } from 'crypto';
import { UserRole } from '../../models/UserRoles';
import { sendMsg91Email } from '../../utils/msg91.utils';
import { getS3Client, buildS3PublicUrl } from '../../utils/s3';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../../config/env';
import { randomUUID } from 'crypto';
import { Model } from 'objection';
import { getDefaultOrganizationExpiresAt } from '../../utils/organization-expiry.utils';
import { DEFAULT_ORGANIZATION_MAX_USERS } from '../../utils/organization-user-limit.utils';
import { findExistingAdminHrCredential } from '../../utils/cross-org-admin-hr-password.utils';
import {
  AdminHrCrossOrgEligibilityError,
  cloneAdminHrPersonDataFromEmail,
} from '../../services/cross-org-admin-hr-onboarding-clone.service';
import { logger } from '../../config/logger';

const splitName = (fullName: string): { first_name: string; last_name: string } => {
  const parts = fullName.trim().split(/\s+/);
  const first_name = parts[0] ?? '';
  const last_name = parts.slice(1).join(' ');
  return { first_name, last_name };
};

export class OrganizationController {
  static async create(req: Request, res: Response): Promise<Response> {
    const { name, company_code, contact_email, admin_name, admin_email } = req.body as {
      name?: string;
      company_code?: string;
      contact_email?: string;
      admin_name?: string;
      admin_email?: string;
    };

    if (!name || !company_code || !contact_email || !admin_name || !admin_email) {
      return res.status(400).json({
        message: 'name, company_code, contact_email, admin_name, admin_email are required',
      });
    }

    const existingOrg = await Organization.query().findOne({ company_code });
    if (existingOrg) {
      return res.status(409).json({ message: 'company_code already exists' });
    }

    const { first_name, last_name } = splitName(admin_name);

    const existingCredential = await findExistingAdminHrCredential(admin_email);
    const passwordReused = Boolean(existingCredential);
    let tempPassword: string | null = passwordReused ? null : generateTempPassword();

    const created = await Organization.transaction(async (trx: any) => {
      const organization = await Organization.query(trx).insert({
        name,
        company_code,
        contact_email,
        subscription_status: 'ACTIVE',
        expires_at: getDefaultOrganizationExpiresAt().toISOString(),
        max_users: DEFAULT_ORGANIZATION_MAX_USERS,
      });

      const password_hash = existingCredential
        ? existingCredential.password_hash
        : await bcrypt.hash(tempPassword as string, 10);
      const must_change_password = existingCredential
        ? existingCredential.must_change_password
        : true;

      const adminUser = await User.query(trx).insert({
        org_id: organization.id,
        employee_id: `${randomBytes(4).toString('hex')}`,
        first_name,
        last_name,
        official_email: admin_email,
        password_hash,
        role: 'admin',
        status: 'ACTIVE',
        must_change_password,
      });

      const users_roles = await Roles.query().where('name', 'admin').first();

      if (!users_roles) {
        throw new Error('Super admin role not found in database');
      }

      await UserRole.query(trx).insert({
        user_id: adminUser.id,
        role_id: users_roles.id,
      });
      return { organization, adminUser, tempPassword, passwordReused };
    });

    // Skip welcome email when password is reused from an existing admin/hr account.
    if (!created.passwordReused && created.tempPassword) {
      try {
        await sendMsg91Email({
          toEmail: admin_email,
          toName: admin_name,
          templateId: 'organization_admin_welcome_email',
          variables: {
            ORG_NAME: name,
            ADMIN_NAME: admin_name,
            LOGIN_EMAIL: admin_email,
            TEMP_PASSWORD: created.tempPassword,
            WEB_LOGIN_URL: process.env.WEB_LOGIN_URL ?? '',
            IOS_APP_URL: process.env.IOS_APP_URL ?? '',
            ANDROID_APP_URL: process.env.ANDROID_APP_URL ?? '',
          },
        });
      } catch (error) {
        // Log error but don't fail the request
        // eslint-disable-next-line no-console
        console.error('Failed to send welcome email to admin:', error);
      }
    }

    let onboardingDataCloned = false;
    if (created.passwordReused) {
      try {
        onboardingDataCloned = await cloneAdminHrPersonDataFromEmail({
          email: admin_email,
          targetUserId: created.adminUser.id,
          targetOrgId: created.organization.id,
          targetRole: 'admin',
        });
      } catch (err) {
        if (err instanceof AdminHrCrossOrgEligibilityError) {
          logger.warn(
            { err, user_id: created.adminUser.id, org_id: created.organization.id },
            'Skipped admin onboarding clone due to eligibility gate',
          );
        } else {
          logger.warn(
            { err, user_id: created.adminUser.id, org_id: created.organization.id },
            'Failed to clone admin onboarding data after org create',
          );
        }
      }
    }

    return res.status(201).json({
      organization: created.organization,
      admin_user: {
        id: created.adminUser.id,
        org_id: created.adminUser.org_id,
        first_name: created.adminUser.first_name,
        last_name: created.adminUser.last_name,
        official_email: created.adminUser.official_email,
        role: created.adminUser.role,
        employee_id: created.adminUser.employee_id,
      },
      password_reused: created.passwordReused,
      onboarding_data_cloned: onboardingDataCloned,
      ...(created.passwordReused ? {} : { temp_password: created.tempPassword }),
    });
  }

  static async createAdmin(req: Request, res: Response): Promise<Response> {
    const { orgId } = req.params as { orgId?: string };
    const { admin_name, admin_email } = req.body as {
      admin_name?: string;
      admin_email?: string;
    };

    if (!orgId) {
      return res.status(400).json({ message: 'orgId is required' });
    }

    if (!admin_name || !admin_email) {
      return res.status(400).json({ message: 'admin_name and admin_email are required' });
    }

    const organization = await Organization.query().findById(orgId);
    if (!organization) {
      return res.status(404).json({ message: 'Organization not found' });
    }

    const existingEmail = await User.query().findOne({
      org_id: orgId,
      official_email: admin_email,
    });
    if (existingEmail) {
      return res.status(409).json({ message: 'Email already exists' });
    }

    const { first_name, last_name } = splitName(admin_name);
    const existingCredential = await findExistingAdminHrCredential(admin_email, {
      excludeOrgId: orgId,
    });
    const passwordReused = Boolean(existingCredential);
    const tempPassword = passwordReused ? null : generateTempPassword();
    const password_hash = existingCredential
      ? existingCredential.password_hash
      : await bcrypt.hash(tempPassword as string, 10);
    const must_change_password = existingCredential
      ? existingCredential.must_change_password
      : true;

    const created = await Model.transaction(async (trx) => {
      const users_roles = await Roles.query(trx).where('name', 'admin').first();
      if (!users_roles) {
        throw new Error('Super admin role not found in database');
      }

      const adminUser = await User.query(trx).insert({
        org_id: orgId,
        employee_id: `${randomBytes(4).toString('hex')}`,
        first_name,
        last_name,
        official_email: admin_email,
        password_hash,
        role: 'admin',
        status: 'ACTIVE',
        must_change_password,
      });

      await UserRole.query(trx).insert({
        user_id: adminUser.id,
        role_id: users_roles.id,
      });

      return adminUser;
    });

    if (!passwordReused && tempPassword) {
      try {
        await sendMsg91Email({
          toEmail: admin_email,
          toName: admin_name,
          templateId: 'organization_admin_welcome_email',
          variables: {
            ORG_NAME: organization.name,
            ADMIN_NAME: admin_name,
            LOGIN_EMAIL: admin_email,
            TEMP_PASSWORD: tempPassword,
            WEB_LOGIN_URL: process.env.WEB_LOGIN_URL ?? '',
            IOS_APP_URL: process.env.IOS_APP_URL ?? '',
            ANDROID_APP_URL: process.env.ANDROID_APP_URL ?? '',
          },
        });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to send welcome email to admin:', error);
      }
    }

    let onboardingDataCloned = false;
    if (passwordReused) {
      try {
        onboardingDataCloned = await cloneAdminHrPersonDataFromEmail({
          email: admin_email,
          targetUserId: created.id,
          targetOrgId: orgId,
          targetRole: 'admin',
        });
      } catch (err) {
        if (err instanceof AdminHrCrossOrgEligibilityError) {
          logger.warn(
            { err, user_id: created.id, org_id: orgId },
            'Skipped admin onboarding clone due to eligibility gate',
          );
        } else {
          logger.warn(
            { err, user_id: created.id, org_id: orgId },
            'Failed to clone admin onboarding data after createAdmin',
          );
        }
      }
    }

    return res.status(201).json({
      admin_user: {
        id: created.id,
        org_id: created.org_id,
        first_name: created.first_name,
        last_name: created.last_name,
        official_email: created.official_email,
        role: created.role,
        employee_id: created.employee_id,
      },
      password_reused: passwordReused,
      onboarding_data_cloned: onboardingDataCloned,
      ...(passwordReused ? {} : { temp_password: tempPassword }),
    });
  }

  static async list(req: Request, res: Response): Promise<Response> {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const limit = Math.max(1, Number(req.query.limit ?? 10));
    const offset = page - 1;

    const result = await Organization.query().page(offset, limit).orderBy('created_at', 'desc');

    return res.json({
      data: result.results,
      page,
      limit,
      total: result.total,
    });
  }

  static async updateExpiry(req: Request, res: Response): Promise<Response> {
    const { id } = req.params;
    const { expires_at } = req.body as { expires_at?: string };

    if (!expires_at || typeof expires_at !== 'string') {
      return res.status(400).json({ message: 'expires_at is required (ISO 8601 datetime)' });
    }

    const parsedExpiry = new Date(expires_at);
    if (Number.isNaN(parsedExpiry.getTime())) {
      return res.status(400).json({ message: 'expires_at must be a valid ISO 8601 datetime' });
    }

    const organization = await Organization.query().findById(id);
    if (!organization) {
      return res.status(404).json({ message: 'Organization not found' });
    }

    const updated = await Organization.query().patchAndFetchById(id, {
      expires_at: parsedExpiry.toISOString(),
    });

    return res.json(updated);
  }

  static async updateUserLimit(req: Request, res: Response): Promise<Response> {
    const { id } = req.params;
    const { max_users } = req.body as { max_users?: number };

    if (max_users === undefined || max_users === null) {
      return res.status(400).json({ message: 'max_users is required' });
    }

    const parsedMaxUsers = Number(max_users);
    if (!Number.isInteger(parsedMaxUsers) || parsedMaxUsers < 1) {
      return res.status(400).json({ message: 'max_users must be an integer of at least 1' });
    }

    const organization = await Organization.query().findById(id);
    if (!organization) {
      return res.status(404).json({ message: 'Organization not found' });
    }

    const updated = await Organization.query().patchAndFetchById(id, {
      max_users: parsedMaxUsers,
    });

    return res.json(updated);
  }

  static async updateStatus(req: Request, res: Response): Promise<Response> {
    const { id } = req.params;
    const { status } = req.body as { status?: string };

    if (!status || !['ACTIVE', 'INACTIVE'].includes(status)) {
      return res.status(400).json({ message: 'status must be ACTIVE or INACTIVE' });
    }

    const organization = await Organization.query().findById(id);
    if (!organization) {
      return res.status(404).json({ message: 'Organization not found' });
    }

    const updated = await Organization.query().patchAndFetchById(id, {
      subscription_status: status,
    });

    return res.json(updated);
  }

  static async getSettings(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const organization = await Organization.query().findById(req.user.org_id);
    if (!organization) {
      return res.status(404).json({ message: 'Organization not found' });
    }

    return res.json({
      message: 'Organization settings fetched successfully',
      data: organization,
    });
  }

  static async updateSettings(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const org_id = req.user.org_id;

    try {
      const organization = await Organization.query().findById(org_id);
      if (!organization) {
        return res.status(404).json({ message: 'Organization not found' });
      }

      const filesFromRequest =
        req.files && !Array.isArray(req.files)
          ? (req.files as Record<string, Express.Multer.File[]>)
          : {};
      const logoFile = filesFromRequest.logo?.[0];
      const faviconFile = filesFromRequest.favicon?.[0];

      let logo_url: string | undefined;
      let favicon_url: string | undefined;
      const s3Client = getS3Client();

      if (logoFile) {
        const fileKey = `organizations/${org_id}/logo/${randomUUID()}-${logoFile.originalname}`;
        await s3Client.send(
          new PutObjectCommand({
            Bucket: env.S3_BUCKET,
            Key: fileKey,
            Body: logoFile.buffer,
            ContentType: logoFile.mimetype,
          }),
        );
        logo_url = buildS3PublicUrl(fileKey);
      }

      if (faviconFile) {
        const fileKey = `organizations/${org_id}/favicon/${randomUUID()}-${faviconFile.originalname}`;
        await s3Client.send(
          new PutObjectCommand({
            Bucket: env.S3_BUCKET,
            Key: fileKey,
            Body: faviconFile.buffer,
            ContentType: faviconFile.mimetype,
          }),
        );
        favicon_url = buildS3PublicUrl(fileKey);
      }

      const hasBodyField = (key: string): boolean =>
        Object.prototype.hasOwnProperty.call(req.body, key);
      const parseBooleanFlag = (value: unknown): boolean => {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value === 1;
        if (typeof value === 'string') {
          const normalized = value.trim().toLowerCase();
          return normalized === 'true' || normalized === '1' || normalized === 'yes';
        }
        return false;
      };

      const updatePayload: Partial<Organization> = {};
      if (logo_url !== undefined) updatePayload.logo_url = logo_url;
      if (favicon_url !== undefined) updatePayload.favicon_url = favicon_url;
      const removeLogo =
        parseBooleanFlag(req.body.remove_logo) || parseBooleanFlag(req.body.removeLogo);
      const removeFavicon =
        parseBooleanFlag(req.body.remove_favicon) || parseBooleanFlag(req.body.removeFavicon);
      if (removeLogo && !logoFile) (updatePayload as any).logo_url = null;
      if (removeFavicon && !faviconFile) (updatePayload as any).favicon_url = null;

      // Privileged flags can only be modified by superadmins (via /api/admin/*).
      if (
        hasBodyField('face_clock_enabled') ||
        hasBodyField('faceClockEnabled') ||
        hasBodyField('kyc_flow_enabled') ||
        hasBodyField('kycFlowEnabled')
      ) {
        return res.status(403).json({
          message:
            'Only superadmins can change face clock and KYC flow settings. Use the superadmin organization settings endpoint.',
        });
      }

      if (hasBodyField('name')) updatePayload.name = req.body.name;
      if (hasBodyField('company_name')) updatePayload.name = req.body.company_name;
      if (hasBodyField('website')) updatePayload.website = req.body.website;
      if (hasBodyField('contact_email')) updatePayload.contact_email = req.body.contact_email;
      if (hasBodyField('email')) updatePayload.contact_email = req.body.email;
      if (hasBodyField('phone_number')) updatePayload.phone_number = req.body.phone_number;
      if (hasBodyField('brand_color')) updatePayload.brand_color = req.body.brand_color;
      if (hasBodyField('primary_color')) updatePayload.brand_color = req.body.primary_color;
      if (hasBodyField('address')) updatePayload.address = req.body.address;
      if (hasBodyField('registered_address')) updatePayload.address = req.body.registered_address;
      if (hasBodyField('cin')) updatePayload.cin = req.body.cin;
      if (hasBodyField('gstin')) updatePayload.gstin = req.body.gstin;
      if (hasBodyField('pf_number')) updatePayload.pf_number = req.body.pf_number;
      if (hasBodyField('pf_no')) updatePayload.pf_number = req.body.pf_no;
      if (hasBodyField('pf_id')) updatePayload.pf_number = req.body.pf_id;

      if (hasBodyField('founded_year')) {
        const foundedYearRaw = req.body.founded_year;
        if (foundedYearRaw !== undefined && foundedYearRaw !== null && foundedYearRaw !== '') {
          const foundedYear = Number(foundedYearRaw);
          if (!Number.isInteger(foundedYear)) {
            return res.status(400).json({ message: 'founded_year must be an integer' });
          }
          updatePayload.founded_year = foundedYear;
        }
      }

      if (hasBodyField('late_grace_period_mins') || hasBodyField('lateGracePeriodMins')) {
        const graceRaw = hasBodyField('late_grace_period_mins')
          ? req.body.late_grace_period_mins
          : req.body.lateGracePeriodMins;
        if (graceRaw !== undefined && graceRaw !== null && graceRaw !== '') {
          const graceMins = Number(graceRaw);
          if (!Number.isInteger(graceMins)) {
            return res.status(400).json({
              message: 'late_grace_period_mins must be an integer (0-60)',
            });
          }
          if (graceMins < 0 || graceMins > 60) {
            return res.status(400).json({
              message: 'late_grace_period_mins must be between 0 and 60',
            });
          }
          (updatePayload as any).late_grace_period_mins = graceMins;
        }
      }

      if (hasBodyField('display_ot') || hasBodyField('displayOt')) {
        const displayOtRaw = hasBodyField('display_ot') ? req.body.display_ot : req.body.displayOt;
        (updatePayload as any).display_ot = parseBooleanFlag(displayOtRaw);
      }

      if (hasBodyField('ot_round_off_enabled') || hasBodyField('otRoundOffEnabled')) {
        const enabledRaw = hasBodyField('ot_round_off_enabled')
          ? req.body.ot_round_off_enabled
          : req.body.otRoundOffEnabled;
        (updatePayload as any).ot_round_off_enabled = parseBooleanFlag(enabledRaw);
      }

      if (hasBodyField('ot_round_off_mins') || hasBodyField('otRoundOffMins')) {
        const minsRaw = hasBodyField('ot_round_off_mins')
          ? req.body.ot_round_off_mins
          : req.body.otRoundOffMins;
        if (minsRaw !== undefined && minsRaw !== null && minsRaw !== '') {
          const mins = Number(minsRaw);
          if (!Number.isInteger(mins)) {
            return res.status(400).json({
              message: 'ot_round_off_mins must be an integer (1-60)',
            });
          }
          if (mins < 1 || mins > 60) {
            return res.status(400).json({
              message: 'ot_round_off_mins must be between 1 and 60',
            });
          }
          (updatePayload as any).ot_round_off_mins = mins;
        }
      }

      if (Object.keys(updatePayload).length === 0) {
        return res.json({ message: 'No changes provided' });
      }

      const updated = await Model.transaction(async (trx) => {
        const updatedOrg = await Organization.query(trx).patchAndFetchById(org_id, updatePayload);

        const kycFlowEnabledUpdated =
          Object.prototype.hasOwnProperty.call(updatePayload, 'kyc_flow_enabled') &&
          (organization as any).kyc_flow_enabled !== (updatedOrg as any).kyc_flow_enabled;

        if (kycFlowEnabledUpdated) {
          const nextEnabled = (updatedOrg as any).kyc_flow_enabled !== false;

          if (!nextEnabled) {
            // When disabling KYC gating: allow onboarding completion + ACTIVE membership
            // based on offer letter + privileged documents only.
            await trx.raw(
              `
              UPDATE user_onboardings uo
              SET
                onboarding_status = 'COMPLETED',
                completed_at = COALESCE(uo.completed_at, NOW()),
                kyc_gating_exempt = TRUE
              FROM users owner
              WHERE owner.id = uo.user_id
                AND owner.org_id = ?
                AND owner.deleted_at IS NULL
                AND uo.onboarding_status = 'IN_PROGRESS'
                AND COALESCE(uo.offer_letter_signed, FALSE) = TRUE
                AND uo.offer_letter_url IS NOT NULL
                AND EXISTS (
                  SELECT 1
                  FROM user_documents ud
                  INNER JOIN users uploader ON uploader.id = ud.uploaded_by
                  WHERE ud.user_id = uo.user_id
                    AND uploader.role IN ('admin', 'hr')
                    AND uploader.org_id = owner.org_id
                );
              `,
              [org_id],
            );

            await trx.raw(
              `
              UPDATE users u
              SET status = 'ACTIVE'
              FROM user_onboardings uo
              WHERE u.id = uo.user_id
                AND u.org_id = ?
                AND u.deleted_at IS NULL
                AND uo.onboarding_status = 'COMPLETED';
              `,
              [org_id],
            );
          } else {
            // When enabling KYC gating: do not retroactively revert users who completed onboarding
            // while KYC gating was disabled. Keep their membership state as-is.
            // Backfill exemption for already-completed onboardings that are still not KYC-verified.
            // This preserves department visibility/headcount for users whose onboarding was completed
            // while KYC flow was disabled, even if their KYC remains pending.
            await trx.raw(
              `
              UPDATE user_onboardings uo
              SET kyc_gating_exempt = TRUE
              FROM users u
              WHERE u.id = uo.user_id
                AND u.org_id = ?
                AND u.deleted_at IS NULL
                AND u.status = 'ACTIVE'
                AND uo.onboarding_status = 'COMPLETED'
                AND COALESCE(uo.kyc_status, '') <> 'VERIFIED'
                AND COALESCE(uo.kyc_gating_exempt, FALSE) = FALSE;
              `,
              [org_id],
            );
          }
        }

        return updatedOrg;
      });

      return res.json({
        message: 'Organization settings updated successfully',
        data: updated,
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Organization Update Error:', error);
      return res.status(500).json({ message: 'Failed to update organization settings' });
    }
  }

  static async updatePrivilegedSettings(req: Request, res: Response): Promise<Response> {
    const { id } = req.params as { id?: string };
    if (!id) {
      return res.status(400).json({ message: 'Organization id is required' });
    }

    const hasBodyField = (key: string): boolean =>
      Object.prototype.hasOwnProperty.call(req.body, key);
    const parseBooleanFlag = (value: unknown): boolean => {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return value === 1;
      if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        return normalized === 'true' || normalized === '1' || normalized === 'yes';
      }
      return false;
    };

    const updatePayload: Partial<Organization> = {};
    if (hasBodyField('face_clock_enabled')) {
      updatePayload.face_clock_enabled = parseBooleanFlag(req.body.face_clock_enabled);
    }
    if (hasBodyField('faceClockEnabled')) {
      updatePayload.face_clock_enabled = parseBooleanFlag(req.body.faceClockEnabled);
    }
    if (hasBodyField('kyc_flow_enabled')) {
      updatePayload.kyc_flow_enabled = parseBooleanFlag(req.body.kyc_flow_enabled);
    }
    if (hasBodyField('kycFlowEnabled')) {
      updatePayload.kyc_flow_enabled = parseBooleanFlag(req.body.kycFlowEnabled);
    }

    if (Object.keys(updatePayload).length === 0) {
      return res.status(400).json({
        message:
          'No privileged settings provided. Allowed fields: face_clock_enabled, kyc_flow_enabled',
      });
    }

    const organization = await Organization.query().findById(id);
    if (!organization) {
      return res.status(404).json({ message: 'Organization not found' });
    }

    const updated = await Organization.query().patchAndFetchById(id, updatePayload);
    return res.json({
      message: 'Organization privileged settings updated successfully',
      data: updated,
    });
  }
}
