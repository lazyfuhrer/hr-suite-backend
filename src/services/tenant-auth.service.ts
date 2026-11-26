import { User } from '../models/User';
import { RefreshToken } from '../models/RefreshToken';
import { Organization } from '../models/Organization';
import { generateToken } from './jwt.service';
import {
  generateRefreshToken,
  getRefreshTokenExpiresAtIso,
  hashRefreshToken,
} from './refresh-token.service';
import { isOrganizationAccessible } from '../utils/organization-expiry.utils';
import { getLocationTrackingStatus } from '../utils/location-tracking.utils';

export const SWITCHABLE_ROLES = ['admin', 'hr'] as const;
export type SwitchableRole = (typeof SWITCHABLE_ROLES)[number];

export const normalizeOfficialEmail = (email: string): string => email.trim().toLowerCase();

export type TenantSessionUser = {
  id: string;
  firstName: string;
  lastName: string;
  role: string;
  org_id: string;
  official_email: string;
  profile_image_url: string | null;
  must_change_password: boolean;
  location_tracking_enabled: boolean;
  display_ot: boolean;
};

export type TenantSessionPayload = {
  token: string;
  refresh_token: string;
  user: TenantSessionUser;
};

export type SwitchableOrganization = {
  org_id: string;
  name: string;
  company_code: string;
  logo_url: string | null;
  role: string;
  is_current: boolean;
};

export const toTenantSessionUser = (
  user: User,
  locationTrackingEnabled = false,
  displayOt = true,
): TenantSessionUser => ({
  id: user.id,
  firstName: user.first_name,
  lastName: user.last_name,
  role: user.role,
  org_id: user.org_id,
  official_email: user.official_email,
  profile_image_url: user.profile_image_url ?? null,
  must_change_password: user.must_change_password,
  location_tracking_enabled: locationTrackingEnabled,
  display_ot: displayOt,
});

export const findEligibleTenantUserByEmailAndOrg = async (
  email: string,
  orgId: string,
  allowedRoles: readonly string[] = SWITCHABLE_ROLES,
): Promise<User | undefined> => {
  const emailNormalized = normalizeOfficialEmail(email);

  const user = await User.query()
    .withGraphJoined('organization')
    .whereRaw('LOWER(TRIM(users.official_email)) = ?', [emailNormalized])
    .where('users.org_id', orgId)
    .whereIn('users.role', [...allowedRoles])
    .whereNull('users.deleted_at')
    .whereNot('users.status', 'INACTIVE')
    .first();

  if (!user) {
    return undefined;
  }

  const org = (user as User & { organization?: Organization }).organization;
  if (!isOrganizationAccessible(org)) {
    return undefined;
  }

  return user;
};

export const issueTenantSession = async (user: User): Promise<TenantSessionPayload> => {
  const tenantToken = generateToken({
    id: user.id,
    org_id: user.org_id,
    role: user.role,
    type: 'tenant',
  });

  const refreshToken = generateRefreshToken();
  await RefreshToken.query().insert({
    token_hash: hashRefreshToken(refreshToken),
    subject_type: 'tenant',
    subject_id: user.id,
    org_id: user.org_id,
    role: user.role,
    expires_at: getRefreshTokenExpiresAtIso(),
  });

  const trackingStatus = await getLocationTrackingStatus(user.org_id, user.id);

  const joinedOrg = (user as User & { organization?: Organization }).organization;
  let displayOt = true;
  if (joinedOrg && typeof joinedOrg.display_ot === 'boolean') {
    displayOt = joinedOrg.display_ot;
  } else {
    const org = await Organization.query().findById(user.org_id).select('display_ot');
    displayOt = org?.display_ot ?? true;
  }

  return {
    token: tenantToken,
    refresh_token: refreshToken,
    user: toTenantSessionUser(user, trackingStatus?.enabled ?? false, displayOt),
  };
};

export const revokeTenantRefreshTokensForUser = async (
  userId: string,
  orgId?: string,
): Promise<void> => {
  const nowIso = new Date().toISOString();
  let query = RefreshToken.query()
    .patch({ revoked_at: nowIso })
    .where('subject_type', 'tenant')
    .where('subject_id', userId)
    .whereNull('revoked_at');

  if (orgId) {
    query = query.where('org_id', orgId);
  }

  await query;
};

export const revokeTenantRefreshTokenByRaw = async (rawRefreshToken: string): Promise<void> => {
  const nowIso = new Date().toISOString();
  await RefreshToken.query()
    .patch({ revoked_at: nowIso })
    .where('token_hash', hashRefreshToken(rawRefreshToken))
    .where('subject_type', 'tenant')
    .whereNull('revoked_at');
};

type SwitchableOrgRow = {
  org_id: string;
  role: string;
  name: string;
  company_code: string;
  logo_url: string | null;
  subscription_status: string;
  deleted_at: string | null;
  expires_at: string | Date | null;
};

export const listSwitchableOrganizations = async (
  email: string,
  currentOrgId: string,
): Promise<SwitchableOrganization[]> => {
  const emailNormalized = normalizeOfficialEmail(email);

  const users = (await User.query()
    .alias('u')
    .select(
      'u.org_id',
      'u.role',
      'o.name',
      'o.company_code',
      'o.logo_url',
      'o.subscription_status',
      'o.deleted_at',
      'o.expires_at',
    )
    .innerJoin('organizations as o', 'o.id', 'u.org_id')
    .whereRaw('LOWER(TRIM(u.official_email)) = ?', [emailNormalized])
    .whereIn('u.role', [...SWITCHABLE_ROLES])
    .whereNull('u.deleted_at')
    .whereNot('u.status', 'INACTIVE')
    .where('u.must_change_password', false)) as unknown as SwitchableOrgRow[];

  const organizations: SwitchableOrganization[] = [];

  for (const row of users) {
    const orgSnapshot = {
      subscription_status: row.subscription_status,
      deleted_at: row.deleted_at,
      expires_at: row.expires_at,
    };

    if (!isOrganizationAccessible(orgSnapshot)) {
      continue;
    }

    organizations.push({
      org_id: row.org_id,
      name: row.name,
      company_code: row.company_code,
      logo_url: row.logo_url ?? null,
      role: row.role,
      is_current: row.org_id === currentOrgId,
    });
  }

  organizations.sort((a, b) => {
    if (a.is_current !== b.is_current) {
      return a.is_current ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return organizations;
};
