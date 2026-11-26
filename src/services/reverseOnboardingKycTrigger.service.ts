import { BankDetail } from '../models/BankDetail';
import { Organization } from '../models/Organization';
import { User } from '../models/User';
import { UserDocument } from '../models/UserDocument';
import { UserIdentity } from '../models/UserIdentity';
import { UserOnboarding } from '../models/UserOnboarding';
import { logger } from '../config/logger';
import { generateCurrentMonthPayrollForUser } from './auto-payroll.service';
import { syncAdminHrOnboardingComplianceForUserIfApplicable } from './cross-org-admin-hr-onboarding-clone.service';

export type TriggerKycResult = {
  user_id: string;
  overall_status: 'VERIFIED' | 'FAILED' | 'PENDING';
  identity: { status: 'VERIFIED' | 'FAILED' | 'PENDING'; code?: string; message?: string };
  bank: { status: 'VERIFIED' | 'FAILED' | 'PENDING'; code?: string; message?: string };
  user_status: string;
};

export function resolveOnboardingStatusFromComplianceAndKyc(params: {
  offerLetterSigned: boolean;
  kycStatus: string | null | undefined;
  hasAdminDocumentsComplete: boolean;
  kycFlowEnabled: boolean;
}): 'IN_PROGRESS' | 'COMPLETED' {
  const normalizedKycStatus = String(params.kycStatus ?? '').toUpperCase();
  if (!params.kycFlowEnabled) {
    return params.offerLetterSigned && params.hasAdminDocumentsComplete
      ? 'COMPLETED'
      : 'IN_PROGRESS';
  }
  return params.offerLetterSigned &&
    params.hasAdminDocumentsComplete &&
    normalizedKycStatus === 'VERIFIED'
    ? 'COMPLETED'
    : 'IN_PROGRESS';
}

export function resolveUserStatusFromKycAndOnboarding(params: {
  kycStatus: string | null | undefined;
  onboardingStatus: string | null | undefined;
  kycFlowEnabled: boolean;
}): 'IN_PROGRESS' | 'ACTIVE' {
  const normalizedKycStatus = String(params.kycStatus ?? '').toUpperCase();
  const normalizedOnboardingStatus = String(params.onboardingStatus ?? '').toUpperCase();
  if (!params.kycFlowEnabled) {
    return normalizedOnboardingStatus === 'COMPLETED' ? 'ACTIVE' : 'IN_PROGRESS';
  }
  return normalizedKycStatus === 'VERIFIED' && normalizedOnboardingStatus === 'COMPLETED'
    ? 'ACTIVE'
    : 'IN_PROGRESS';
}

async function isKycFlowEnabledForOrg(org_id: string): Promise<boolean> {
  const organization = await Organization.query()
    .select('id', 'kyc_flow_enabled')
    .where('id', org_id)
    .first();

  // Backward-compatible default: enabled unless explicitly false.
  if (!organization) {
    return true;
  }

  return (organization as any).kyc_flow_enabled !== false;
}

export async function triggerUserKycVerification(
  org_id: string,
  user_id: string,
): Promise<TriggerKycResult> {
  const providerName = process.env.KYC_PROVIDER_NAME ?? 'external';
  const user = await User.query().where({ id: user_id, org_id }).whereNull('deleted_at').first();

  if (!user) {
    throw new Error('User not found in this organization');
  }

  const [onboarding, identities, bankDetail, documents] = await Promise.all([
    UserOnboarding.query().findOne({ user_id: user.id }),
    UserIdentity.query().where({ user_id: user.id }),
    BankDetail.query().findOne({ user_id: user.id }),
    UserDocument.query().where({ user_id: user.id }),
  ]);
  const kycFlowEnabled = await isKycFlowEnabledForOrg(org_id);
  const existingKycStatus = String(onboarding?.kyc_status ?? '').toUpperCase();
  const isKycAlreadyVerified = existingKycStatus === 'VERIFIED';
  const lockMembership =
    String(onboarding?.onboarding_status ?? '').toUpperCase() === 'COMPLETED' &&
    String((user as any)?.status ?? '').toUpperCase() === 'ACTIVE';
  const uploaderIds = Array.from(
    new Set(
      documents
        .map((doc: any) => doc.uploaded_by)
        .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0),
    ),
  );
  let privilegedUploaderIdSet = new Set<string>();
  if (uploaderIds.length > 0) {
    const privilegedUploaders = await User.query()
      .whereIn('id', uploaderIds)
      .where('org_id', org_id)
      .whereIn('role', ['admin', 'hr'])
      .select('id');
    privilegedUploaderIdSet = new Set(privilegedUploaders.map((u) => u.id));
  }
  const hasAdminDocumentsComplete = documents.some(
    (doc: any) =>
      typeof doc.uploaded_by === 'string' && privilegedUploaderIdSet.has(doc.uploaded_by),
  );

  const aadhaarIdentity =
    identities.find((i) => i.id_type === 'AADHAR') ??
    identities.find((i) => i.id_type === 'AADHAAR');
  const panIdentity = identities.find((i) => i.id_type === 'PAN');

  await UserDocument.query()
    .whereIn(
      'id',
      documents
        .filter((d) => ['AADHAR_FRONT', 'AADHAR_BACK'].includes(d.doc_type))
        .map((d) => d.id),
    )
    .patch({ verification_status: 'IN_PROGRESS' });

  await UserOnboarding.query()
    .where({ user_id: user.id })
    .whereRaw("COALESCE(upper(kyc_status), '') <> 'VERIFIED'")
    .patch({ kyc_status: 'IN_PROGRESS' });

  // Identity: rely on Sandbox Aadhaar OTP and PAN verification flows having populated
  // Aadhaar and PAN identity records for this user.
  // Aadhaar is considered verified only after OTP verification flow enriches
  // the identity with verified holder data (name_on_document).
  const hasAadhaar =
    Boolean(aadhaarIdentity?.id_number) && Boolean(aadhaarIdentity?.name_on_document);
  // PAN verify API persists both PAN number and holder name on successful verification.
  const hasPan = Boolean(panIdentity?.id_number) && Boolean(panIdentity?.name_on_document);
  const hasBothIdentities = hasAadhaar && hasPan;
  const identityResult = hasBothIdentities
    ? {
        status: 'VERIFIED' as const,
        code: 'AADHAAR_PAN_OK',
        message: 'Aadhaar and PAN identities verified via Sandbox',
      }
    : {
        status: 'PENDING' as const,
        code: 'AADHAAR_OR_PAN_PENDING',
        message: 'Waiting for Aadhaar and PAN verification',
      };
  const bankVerificationStatus = String(bankDetail?.verification_status ?? 'PENDING').toUpperCase();
  const bankResult =
    bankVerificationStatus === 'VERIFIED'
      ? ({
          status: 'VERIFIED',
          code: 'BANK_OK',
          message: 'Bank account verified via Sandbox',
        } as const)
      : bankVerificationStatus === 'FAILED'
        ? ({
            status: 'FAILED',
            code: 'BANK_NOT_VERIFIED',
            message:
              bankDetail?.verification_failure_reason ?? 'Bank account could not be verified',
          } as const)
        : ({
            status: 'PENDING',
            code: 'BANK_PENDING',
            message:
              bankDetail?.verification_failure_reason ?? 'Waiting for bank account verification',
          } as const);

  const allVerified = identityResult.status === 'VERIFIED' && bankResult.status === 'VERIFIED';
  const shouldRemainPending =
    identityResult.status === 'PENDING' || bankResult.status === 'PENDING';

  const aadharDocs = documents.filter((d) => ['AADHAR_FRONT', 'AADHAR_BACK'].includes(d.doc_type));
  for (const doc of aadharDocs) {
    await UserDocument.query()
      .patch({
        verification_status: identityResult.status === 'VERIFIED' ? 'VERIFIED' : 'PENDING',
        verification_meta: null,
      } as any)
      .where({ id: doc.id });
  }

  const nowIso = new Date().toISOString();

  // Missing identities should not reject invited/in-progress users.
  // Keep KYC pending until Aadhaar + PAN are both verified.
  if (shouldRemainPending) {
    const onboardingStatus = resolveOnboardingStatusFromComplianceAndKyc({
      offerLetterSigned: Boolean(onboarding?.offer_letter_signed || onboarding?.offer_letter_url),
      // If KYC is already VERIFIED, do not treat pending signals as a reason to regress.
      kycStatus: isKycAlreadyVerified ? 'VERIFIED' : 'PENDING',
      hasAdminDocumentsComplete,
      kycFlowEnabled,
    });

    // Always allow onboarding_status/completed_at to update. Never downgrade VERIFIED KYC.
    await UserOnboarding.query()
      .where({ user_id: user.id })
      .patch({
        ...(isKycAlreadyVerified
          ? {}
          : {
              kyc_status: 'PENDING',
              kyc_failure_reason: undefined,
              kyc_checked_at: nowIso,
              kyc_provider: providerName,
            }),
        ...(lockMembership
          ? {}
          : {
              onboarding_status: onboardingStatus,
              completed_at: onboardingStatus === 'COMPLETED' ? nowIso : null,
            }),
      } as any);

    const pendingStatus = resolveUserStatusFromKycAndOnboarding({
      kycStatus: isKycAlreadyVerified ? 'VERIFIED' : 'PENDING',
      onboardingStatus,
      kycFlowEnabled,
    });

    if (!lockMembership) {
      await User.query().patch({ status: pendingStatus }).where({ id: user.id });
    }

    const effectiveUserStatus = lockMembership ? 'ACTIVE' : pendingStatus;

    syncAdminHrOnboardingComplianceForUserIfApplicable({
      userId: user.id,
      orgId: org_id,
      role: user.role,
      email: user.official_email,
      includeLetterDocs: false,
    }).catch((err) => {
      logger.error(
        { err, user_id: user.id, org_id },
        'Failed to sync admin/hr KYC/onboarding status across orgs',
      );
    });

    return {
      user_id: user.id,
      overall_status: isKycAlreadyVerified ? 'VERIFIED' : 'PENDING',
      identity: {
        status: identityResult.status,
        code: identityResult.code,
        message: identityResult.message,
      },
      bank: {
        status: bankResult.status,
        code: bankResult.code,
        message: bankResult.message,
      },
      user_status: effectiveUserStatus,
    };
  }

  const resolvedOnboardingStatus = resolveOnboardingStatusFromComplianceAndKyc({
    offerLetterSigned: Boolean(onboarding?.offer_letter_signed || onboarding?.offer_letter_url),
    kycStatus: isKycAlreadyVerified ? 'VERIFIED' : allVerified ? 'VERIFIED' : 'FAILED',
    hasAdminDocumentsComplete,
    kycFlowEnabled,
  });

  // Always allow onboarding_status/completed_at to update. Never downgrade VERIFIED KYC.
  await UserOnboarding.query()
    .where({ user_id: user.id })
    .patch({
      ...(isKycAlreadyVerified
        ? {}
        : {
            kyc_status: allVerified ? 'VERIFIED' : 'FAILED',
            kyc_failure_reason: allVerified
              ? undefined
              : (identityResult.message ??
                bankResult.message ??
                'KYC verification failed. Please review documents and try again.'),
            kyc_checked_at: nowIso,
            kyc_provider: providerName,
          }),
      ...(lockMembership
        ? {}
        : {
            onboarding_status: resolvedOnboardingStatus,
            completed_at: resolvedOnboardingStatus === 'COMPLETED' ? nowIso : null,
          }),
    } as any);

  const resolvedUserStatus = resolveUserStatusFromKycAndOnboarding({
    kycStatus: isKycAlreadyVerified ? 'VERIFIED' : allVerified ? 'VERIFIED' : 'FAILED',
    onboardingStatus: resolvedOnboardingStatus,
    kycFlowEnabled,
  });

  if (!lockMembership) {
    await User.query().patch({ status: resolvedUserStatus }).where({ id: user.id });
  }

  const effectiveResolvedUserStatus = lockMembership ? 'ACTIVE' : resolvedUserStatus;

  if (allVerified) {
    generateCurrentMonthPayrollForUser(user.id, org_id).catch(() => {
      // best-effort: KYC success should not fail because payroll generation fails
    });
  }

  syncAdminHrOnboardingComplianceForUserIfApplicable({
    userId: user.id,
    orgId: org_id,
    role: user.role,
    email: user.official_email,
    includeLetterDocs: false,
  }).catch((err) => {
    logger.error(
      { err, user_id: user.id, org_id },
      'Failed to sync admin/hr KYC/onboarding status across orgs',
    );
  });

  return {
    user_id: user.id,
    overall_status: allVerified ? 'VERIFIED' : 'FAILED',
    identity: {
      status: identityResult.status,
      code: identityResult.code,
      message: identityResult.message,
    },
    bank: {
      status: bankResult.status,
      code: bankResult.code,
      message: bankResult.message,
    },
    user_status: effectiveResolvedUserStatus,
  };
}
