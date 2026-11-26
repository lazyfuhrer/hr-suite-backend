import type { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import { Model } from 'objection';

import { Organization } from '../../models/Organization';
import { RefreshToken } from '../../models/RefreshToken';
import { User } from '../../models/User';
import { PasswordResetToken } from '../../models/PasswordResetToken';
import { generatePasswordResetToken, generateToken, verifyToken } from '../../services/jwt.service';
import {
  findEligibleTenantUserByEmailAndOrg,
  issueTenantSession,
  listSwitchableOrganizations,
  revokeTenantRefreshTokenByRaw,
  revokeTenantRefreshTokensForUser,
} from '../../services/tenant-auth.service';
import {
  isAdminOrHrRole,
  syncAdminHrPasswordByEmail,
} from '../../utils/cross-org-admin-hr-password.utils';
import {
  resetForgetPasswordSchema,
  switchOrgSchema,
  verifyForgetPasswordOtpSchema,
} from '../../validators/tenant';
import {
  generateRefreshToken,
  getRefreshTokenExpiresAtIso,
  hashRefreshToken,
} from '../../services/refresh-token.service';
import { sendMsg91Email } from '../../utils/msg91.utils';
import {
  getOrganizationAccessDenialMessage,
  isOrganizationAccessible,
  ORGANIZATION_EXPIRED_MESSAGE,
  ORGANIZATION_INACTIVE_MESSAGE,
  OrganizationAccessSnapshot,
  sendOrganizationAccessDenied,
} from '../../utils/organization-expiry.utils';

export class AuthController {
  static async login(req: Request, res: Response): Promise<Response> {
    const { email, password, org_id } = req.body as {
      email?: string;
      password?: string;
      org_id?: string;
    };

    if (org_id) {
      return res.status(400).json({ message: 'org_id is not allowed in login' });
    }

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const emailNormalized = email.trim().toLowerCase();

    const users = await User.query()
      .select(
        'id',
        'org_id',
        'role',
        'first_name',
        'last_name',
        'official_email',
        'status',
        'password_hash',
        'must_change_password',
      )
      .whereRaw('LOWER(TRIM(official_email)) = ?', [emailNormalized]);

    if (users.length === 0) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const matches = await Promise.all(
      users.map(async (user) => ({
        user,
        passwordMatches: await bcrypt.compare(password, user.password_hash),
      })),
    );

    const validUsers = matches
      .filter((entry) => entry.passwordMatches)
      .map((entry) => entry.user)
      .filter((user) => user.status !== 'INACTIVE');

    if (validUsers.length === 0) {
      const hasInactive = matches.some((entry) => entry.passwordMatches);
      return res
        .status(hasInactive ? 403 : 401)
        .json({ message: hasInactive ? 'User is inactive' : 'Invalid credentials' });
    }

    const orgIds = [...new Set(validUsers.map((user) => user.org_id))];
    const orgRows = await Organization.query()
      .select(
        'id',
        'name',
        'company_code',
        'logo_url',
        'subscription_status',
        'deleted_at',
        'expires_at',
      )
      .whereIn('id', orgIds);

    const activeOrgs = orgRows.filter((org) => isOrganizationAccessible(org));
    const activeOrgIds = new Set(activeOrgs.map((org) => org.id));

    const eligibleUsers = validUsers.filter((user) => activeOrgIds.has(user.org_id));
    if (eligibleUsers.length === 0) {
      const denialMessages = validUsers
        .map((user) =>
          getOrganizationAccessDenialMessage(orgRows.find((row) => row.id === user.org_id)),
        )
        .filter((message): message is string => Boolean(message));
      const message = denialMessages.includes(ORGANIZATION_EXPIRED_MESSAGE)
        ? ORGANIZATION_EXPIRED_MESSAGE
        : (denialMessages[0] ?? ORGANIZATION_INACTIVE_MESSAGE);
      return res.status(403).json({ message });
    }

    const organizations = activeOrgs.map((org) => ({
      org_id: org.id,
      name: org.name,
      company_code: org.company_code,
      logo_url: org.logo_url,
    }));

    return res.json({
      selection_token: generateToken({
        id: eligibleUsers[0].id,
        email: emailNormalized,
        org_ids: organizations.map((org) => org.org_id),
        role: 'pending',
        type: 'tenant_select',
      }),
      organizations,
    });
  }

  static async selectOrg(req: Request, res: Response): Promise<Response> {
    const { org_id } = req.body as { org_id?: string };
    if (!org_id) {
      return res.status(400).json({ message: 'org_id is required' });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const token = authHeader.slice('Bearer '.length).trim();
    let payload;
    try {
      payload = verifyToken(token);
    } catch {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!payload || payload.type !== 'tenant_select' || !payload.email || !payload.org_ids) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    if (!payload.org_ids.includes(org_id)) {
      return res.status(403).json({ message: 'Org selection not allowed' });
    }

    const selectEmailNormalized = payload.email.trim().toLowerCase();

    const user = await User.query()
      .withGraphJoined('organization')
      .whereRaw('LOWER(TRIM(users.official_email)) = ?', [selectEmailNormalized])
      .where('users.org_id', org_id)
      .first();

    if (!user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (user.status === 'INACTIVE') {
      return res.status(403).json({ message: 'User is inactive' });
    }

    const orgStatus = (user as User & { organization?: OrganizationAccessSnapshot }).organization;
    if (sendOrganizationAccessDenied(res, orgStatus)) {
      return res;
    }

    const session = await issueTenantSession(user);
    return res.json(session);
  }

  static async listSwitchableOrgs(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const organizations = await listSwitchableOrganizations(
      req.user.official_email,
      req.user.org_id,
    );

    return res.json({
      current_org_id: req.user.org_id,
      organizations,
    });
  }

  static async switchOrg(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = switchOrgSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { org_id: targetOrgId, refresh_token: refreshTokenFromBody } = parsed.data;

    if (targetOrgId === req.user.org_id) {
      return res.status(400).json({ message: 'Already in this organization' });
    }

    const targetUser = await findEligibleTenantUserByEmailAndOrg(
      req.user.official_email,
      targetOrgId,
    );

    if (!targetUser) {
      return res.status(403).json({ message: 'Org switch not allowed' });
    }

    if (targetUser.must_change_password) {
      return res.status(403).json({ message: 'Password reset required' });
    }

    if (refreshTokenFromBody) {
      await revokeTenantRefreshTokenByRaw(refreshTokenFromBody);
    }

    await revokeTenantRefreshTokensForUser(req.user.id);

    const session = await issueTenantSession(targetUser);
    return res.json(session);
  }

  static async refresh(req: Request, res: Response): Promise<Response> {
    const { refresh_token } = req.body as { refresh_token?: string };

    if (!refresh_token) {
      return res.status(400).json({ message: 'refresh_token is required' });
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const tokenHash = hashRefreshToken(refresh_token);

    // Validate basic constraints before starting rotation transaction.
    const existing = await RefreshToken.query()
      .where('token_hash', tokenHash)
      .where('subject_type', 'tenant')
      .whereNull('revoked_at')
      .where('expires_at', '>', nowIso)
      .first();

    if (!existing) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    let statusCode = 401;
    let body: Record<string, unknown> = { message: 'Unauthorized' };

    await Model.transaction(async (trx) => {
      const locked = await RefreshToken.query(trx).where('id', existing.id).forUpdate().first();

      if (!locked || locked.revoked_at || locked.expires_at <= nowIso) {
        statusCode = 401;
        body = { message: 'Unauthorized' };
        return;
      }

      if (!locked.org_id) {
        statusCode = 401;
        body = { message: 'Unauthorized' };
        return;
      }

      const user = await User.query(trx)
        .withGraphJoined('organization')
        .whereRaw('users.id = ? and users.org_id = ?', [locked.subject_id, locked.org_id])
        .first();

      if (!user || user.status === 'INACTIVE') {
        statusCode = 401;
        body = { message: 'Unauthorized' };
        return;
      }

      // Preserve existing behavior: tenant endpoints require password reset when flagged.
      if (user.must_change_password) {
        statusCode = 403;
        body = { message: 'Password reset required' };
        return;
      }

      const orgStatus = (user as User & { organization?: OrganizationAccessSnapshot }).organization;
      const denialMessage = getOrganizationAccessDenialMessage(orgStatus);
      if (denialMessage) {
        statusCode = 403;
        body = { message: denialMessage };
        return;
      }

      // Rotation step: create successor refresh token + revoke current one.
      const newRefreshToken = generateRefreshToken();

      const newRefreshRow = await RefreshToken.query(trx).insertAndFetch({
        token_hash: hashRefreshToken(newRefreshToken),
        subject_type: 'tenant',
        subject_id: user.id,
        org_id: user.org_id,
        role: user.role,
        expires_at: getRefreshTokenExpiresAtIso(),
      });

      await RefreshToken.query(trx)
        .patch({
          revoked_at: nowIso,
          replaced_by: newRefreshRow.id,
        })
        .where('id', locked.id);

      const tenantToken = generateToken({
        id: user.id,
        org_id: user.org_id,
        role: user.role,
        type: 'tenant',
      });

      statusCode = 200;
      body = {
        token: tenantToken,
        refresh_token: newRefreshToken,
        user: {
          id: user.id,
          firstName: user.first_name,
          lastName: user.last_name,
          role: user.role,
          org_id: user.org_id,
          official_email: user.official_email,
          profile_image_url: (user as any).profile_image_url ?? null,
          must_change_password: user.must_change_password,
        },
      };
    });

    return res.status(statusCode).json(body);
  }

  static async resetPassword(req: Request, res: Response): Promise<Response> {
    const { currentPassword, newPassword } = req.body as {
      currentPassword?: string;
      newPassword?: string;
    };

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'currentPassword and newPassword are required' });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const token = authHeader.slice('Bearer '.length).trim();
    let payload;
    try {
      payload = verifyToken(token);
    } catch {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (!payload || payload.type !== 'tenant' || !payload.org_id) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const user = await User.query()
      .withGraphJoined('organization')
      .whereRaw('users.id = ? and users.org_id = ?', [payload.id, payload.org_id])
      .first();

    if (!user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const orgStatus = (user as User & { organization?: OrganizationAccessSnapshot }).organization;
    if (sendOrganizationAccessDenied(res, orgStatus)) {
      return res;
    }

    const passwordMatches = await bcrypt.compare(currentPassword, user.password_hash);
    if (!passwordMatches) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const password_hash = await bcrypt.hash(newPassword, 10);
    await User.query().patchAndFetchById(user.id, {
      password_hash,
      must_change_password: false,
    });

    if (isAdminOrHrRole(user.role)) {
      await syncAdminHrPasswordByEmail(
        user.official_email,
        { password_hash, must_change_password: false },
        { exceptUserId: user.id },
      );
    }

    return res.json({ message: 'Password updated' });
  }

  static async forgetPassword(req: Request, res: Response): Promise<Response> {
    const { email } = req.body as { email?: string };

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const user = (await AuthController.findUserWithOrganizationByEmail(email)) as
      | (User & { organization?: { name?: string } })
      | undefined;

    if (!user) {
      return res.status(404).json({ message: 'No account found for this email' });
    }

    if (
      sendOrganizationAccessDenied(
        res,
        (user as User & { organization?: OrganizationAccessSnapshot }).organization,
      )
    ) {
      return res;
    }

    const otp = randomInt(1000, 10000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    const mailResult = await AuthController.sendForgotPasswordOtpEmail(user, otp);
    if (!mailResult.success) {
      // eslint-disable-next-line no-console
      console.error('Failed to send forgot password OTP email:', mailResult.error);
      return res.status(503).json({
        message: 'Unable to send OTP email. Please try again later.',
      });
    }

    try {
      await Model.transaction(async (trx) => {
        const nowIso = new Date().toISOString();

        await PasswordResetToken.query(trx)
          .patch({ consumed_at: nowIso })
          .where({ user_id: user.id })
          .whereNull('consumed_at');

        await PasswordResetToken.query(trx).insert({
          user_id: user.id,
          otp_code: otp,
          expires_at: expiresAt.toISOString(),
        });
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to persist forgot password OTP after email was sent:', error);
      return res.status(500).json({
        message: 'Unable to complete password reset. Please try again.',
      });
    }

    return res.json({ message: 'OTP has been sent to your email' });
  }

  static async resendForgetPasswordOtp(req: Request, res: Response): Promise<Response> {
    const { email } = req.body as { email?: string };

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const user = (await AuthController.findUserWithOrganizationByEmail(email)) as
      | (User & { organization?: { name?: string } })
      | undefined;

    if (!user) {
      return res.status(404).json({ message: 'No account found for this email' });
    }

    if (
      sendOrganizationAccessDenied(
        res,
        (user as User & { organization?: OrganizationAccessSnapshot }).organization,
      )
    ) {
      return res;
    }

    const now = new Date();

    const existingToken = await PasswordResetToken.query()
      .where({ user_id: user.id })
      .whereNull('consumed_at')
      .where('expires_at', '>', now.toISOString())
      .orderBy('created_at', 'desc')
      .first();

    let otp: string;
    let newTokenId: string | undefined;

    if (existingToken) {
      otp = existingToken.otp_code;
    } else {
      otp = randomInt(1000, 10000).toString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      const inserted = await PasswordResetToken.query().insertAndFetch({
        user_id: user.id,
        otp_code: otp,
        expires_at: expiresAt.toISOString(),
      });
      newTokenId = inserted.id;
    }

    const mailResult = await AuthController.sendForgotPasswordOtpEmail(user, otp);
    if (!mailResult.success) {
      // eslint-disable-next-line no-console
      console.error('Failed to resend forgot password OTP email:', mailResult.error);
      if (newTokenId) {
        await PasswordResetToken.query().deleteById(newTokenId);
      }
      return res.status(503).json({
        message: 'Unable to send OTP email. Please try again later.',
      });
    }

    return res.json({ message: 'OTP has been sent to your email' });
  }

  static async verifyForgetPasswordOtp(req: Request, res: Response): Promise<Response> {
    const parsed = verifyForgetPasswordOtpSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { email, otp } = parsed.data;
    const result = await AuthController.findUserAndPasswordResetToken(email, otp);

    if (!result) {
      return res.status(400).json({ message: 'Invalid OTP or email' });
    }

    const { user, token } = result;

    const userWithOrg = await User.query().withGraphJoined('organization').findById(user.id);
    if (
      sendOrganizationAccessDenied(
        res,
        (userWithOrg as User & { organization?: OrganizationAccessSnapshot }).organization,
      )
    ) {
      return res;
    }

    const emailNormalized = email.trim().toLowerCase();

    const reset_token = generatePasswordResetToken({
      id: user.id,
      email: emailNormalized,
      reset_token_id: token.id,
    });

    return res.json({
      message: 'OTP verified successfully',
      reset_token,
    });
  }

  static async resetForgetPassword(req: Request, res: Response): Promise<Response> {
    const parsed = resetForgetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { reset_token, newPassword } = parsed.data;

    let payload;
    try {
      payload = verifyToken(reset_token);
    } catch {
      return res.status(401).json({ message: 'Invalid or expired reset token' });
    }

    if (
      payload.type !== 'password_reset' ||
      !payload.reset_token_id ||
      !payload.id ||
      !payload.email
    ) {
      return res.status(401).json({ message: 'Invalid or expired reset token' });
    }

    const now = new Date();
    const token = await PasswordResetToken.query()
      .findById(payload.reset_token_id)
      .where({ user_id: payload.id })
      .whereNull('consumed_at')
      .where('expires_at', '>', now.toISOString());

    if (!token) {
      return res.status(400).json({ message: 'Invalid or expired reset token' });
    }

    const user = await User.query().withGraphJoined('organization').findById(payload.id);
    if (
      !user ||
      user.id !== payload.id ||
      user.official_email.trim().toLowerCase() !== payload.email.trim().toLowerCase()
    ) {
      return res.status(401).json({ message: 'Invalid or expired reset token' });
    }

    if (
      sendOrganizationAccessDenied(
        res,
        (user as User & { organization?: OrganizationAccessSnapshot }).organization,
      )
    ) {
      return res;
    }

    const password_hash = await bcrypt.hash(newPassword, 10);
    const nowIso = now.toISOString();

    await Model.transaction(async (trx) => {
      await PasswordResetToken.query(trx)
        .patch({ consumed_at: nowIso })
        .where({ user_id: user.id })
        .whereNull('consumed_at');

      await User.query(trx).patchAndFetchById(user.id, {
        password_hash,
        must_change_password: false,
      });

      if (isAdminOrHrRole(user.role)) {
        await syncAdminHrPasswordByEmail(
          user.official_email,
          { password_hash, must_change_password: false },
          { exceptUserId: user.id, trx },
        );
      }
    });

    return res.json({ message: 'Password has been reset successfully' });
  }

  private static findUserByOfficialEmailNormalized(email: string) {
    const emailNormalized = email.trim().toLowerCase();
    return User.query().whereRaw('LOWER(TRIM(official_email)) = ?', [emailNormalized]).first();
  }

  private static findUserWithOrganizationByEmail(email: string) {
    const emailNormalized = email.trim().toLowerCase();
    return User.query()
      .withGraphJoined('organization')
      .whereRaw('LOWER(TRIM(official_email)) = ?', [emailNormalized])
      .first();
  }

  private static async findUserAndPasswordResetToken(email: string, otp: string) {
    const user = await AuthController.findUserByOfficialEmailNormalized(email);
    if (!user) {
      return null;
    }

    const now = new Date();
    const token = await PasswordResetToken.query()
      .where({ user_id: user.id, otp_code: otp })
      .whereNull('consumed_at')
      .where('expires_at', '>', now.toISOString())
      .orderBy('created_at', 'desc')
      .first();

    if (!token) {
      return null;
    }

    return { user, token };
  }

  private static buildForgotPasswordEmailVariables(
    user: User & { organization?: { name?: string } },
    otp: string,
  ): Record<string, string> {
    const fullName = AuthController.getUserFullName(user);
    return {
      ORG_NAME: user.organization?.name ?? 'HR Suite',
      USER_NAME: fullName || user.official_email,
      OTP_CODE: otp,
      OTP_VALIDITY: '10 minutes',
    };
  }

  private static getUserFullName(user: User): string {
    return `${user.first_name} ${user.last_name}`.trim() || user.first_name || '';
  }

  private static sendForgotPasswordOtpEmail(
    user: User & { organization?: { name?: string } },
    otp: string,
  ) {
    const fullName = AuthController.getUserFullName(user);
    return sendMsg91Email({
      toEmail: user.official_email,
      toName: fullName,
      templateId: 'otp_verification_email_template',
      variables: AuthController.buildForgotPasswordEmailVariables(user, otp),
    });
  }
}
