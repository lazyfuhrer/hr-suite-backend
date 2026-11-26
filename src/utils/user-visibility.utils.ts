import { UserOnboarding } from '../models/UserOnboarding';
import { Organization } from '../models/Organization';

export async function isKycFlowEnabledForOrg(org_id: string): Promise<boolean> {
  const org = await Organization.query()
    .select('id', 'kyc_flow_enabled')
    .where('id', org_id)
    .first();
  return (org as any)?.kyc_flow_enabled !== false;
}

/**
 * Excludes users whose onboarding is still IN_PROGRESS.
 * Users without an onboarding row are included for legacy/backfill safety.
 */
export const applyExcludeInProgressOnboardingFilter = (query: any, userAlias = 'users'): any => {
  return query.whereNotExists(
    UserOnboarding.query()
      .select(1)
      .whereRaw('user_onboardings.user_id = ??', [`${userAlias}.id`])
      .where('user_onboardings.onboarding_status', 'IN_PROGRESS'),
  );
};

export const applyOrgMemberVisibilityFilter = (
  query: any,
  params: { kycFlowEnabled: boolean; userAlias?: string },
): any => {
  if (!params.kycFlowEnabled) {
    return query;
  }

  const userAlias = params.userAlias ?? 'users';
  applyExcludeInProgressOnboardingFilter(query, userAlias);
  return query.whereExists(
    UserOnboarding.query()
      .select(1)
      .whereRaw('user_onboardings.user_id = ??', [`${userAlias}.id`])
      .where('user_onboardings.kyc_status', 'VERIFIED'),
  );
};
