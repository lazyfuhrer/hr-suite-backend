import { randomBytes } from 'crypto';
import type { Transaction } from 'objection';
import { CopyObjectCommand } from '@aws-sdk/client-s3';

import { env } from '../config/env';
import { logger } from '../config/logger';
import { Address } from '../models/Address';
import { BankDetail } from '../models/BankDetail';
import { EmergencyContact } from '../models/EmergencyContact';
import { EmployeeBenefit } from '../models/EmployeeBenefit';
import { EmployeeEmploymentDetail } from '../models/EmployeeEmploymentDetail';
import { Organization } from '../models/Organization';
import { Roles } from '../models/Roles';
import { SalaryComponent } from '../models/SalaryComponent';
import { SalaryStructure } from '../models/SalaryStructure';
import { User } from '../models/User';
import { UserDocument } from '../models/UserDocument';
import { UserIdentity } from '../models/UserIdentity';
import { UserOnboarding } from '../models/UserOnboarding';
import { UserPayrollDetail } from '../models/UserPayrollDetail';
import { UserProfile } from '../models/UserProfile';
import { UserRole } from '../models/UserRoles';
import { indexUserFaceFromS3 } from './face-recognition.service';
import { buildS3PublicUrl, getS3Client } from '../utils/s3';
import { findSourceAdminHrUser, isAdminOrHrRole } from '../utils/cross-org-admin-hr-password.utils';
import { normalizeOfficialEmail, SWITCHABLE_ROLES } from '../services/tenant-auth.service';
import { assertOrganizationUserLimit } from '../utils/organization-user-limit.utils';

/** Mirrors resolveUserStatusFromKycAndOnboarding — kept local to avoid circular imports. */
function resolveUserStatusFromKycAndOnboarding(params: {
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

const LETTER_DOC_TYPES = new Set([
  'OFFER_LETTER',
  'OFFER_LETTER_URL',
  'SIGNED_JOINING_LETTER',
  'SIGNED_JOINING_LETTER_URL',
]);

export type CloneAdminHrPersonDataInput = {
  sourceUserId: string;
  sourceOrgId: string;
  targetUserId: string;
  targetOrgId: string;
  trx?: Transaction;
  /**
   * When true (continuous sync), overwrite target rows and copy bank verification as stored.
   * When false (initial clone), bank verification resets to PENDING.
   */
  syncMode?: boolean;
};

export type CloneAdminHrPersonDataResult = {
  cloned: boolean;
  passportPhotoKey?: string | null;
};

export type AdminHrLetterDocPayload = {
  doc_type: string;
  doc_category?: string | null;
  file_url: string;
  file_key?: string | null;
};

export type AdminHrOnboardingCompliancePayload = {
  asset_device_pref?: string | null;
  asset_agreement_accepted?: boolean;
  device_serial_number?: string | null;
  policy_acknowledged?: boolean;
  offer_letter_signed?: boolean;
  offer_letter_url?: string | null;
  onboarding_status?: string | null;
  completed_at?: string | null;
  kyc_status?: string | null;
  kyc_failure_reason?: string | null;
  kyc_checked_at?: string | null;
  kyc_provider?: string | null;
  kyc_gating_exempt?: boolean;
  letterDocs?: AdminHrLetterDocPayload[];
  sourceUserId?: string;
  sourceOrgId?: string;
};

export type SyncAdminHrOnboardingComplianceOptions = {
  exceptUserId?: string;
  trx?: Transaction;
};

export type SyncAdminHrFullOptions = {
  exceptUserId?: string;
  sourceUserId: string;
  sourceOrgId: string;
  trx?: Transaction;
};

export class AdminHrCrossOrgEligibilityError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'AdminHrCrossOrgEligibilityError';
  }
}

export class AdminHrCrossOrgNotFoundError extends Error {
  readonly statusCode = 404;
  constructor(message: string) {
    super(message);
    this.name = 'AdminHrCrossOrgNotFoundError';
  }
}

export class AdminHrCrossOrgConflictError extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = 'AdminHrCrossOrgConflictError';
  }
}

function mapS3Key(
  sourceKey: string,
  sourceOrgId: string,
  sourceUserId: string,
  targetOrgId: string,
  targetUserId: string,
): string {
  const prefix = `orgs/${sourceOrgId}/users/${sourceUserId}/`;
  if (sourceKey.startsWith(prefix)) {
    return `orgs/${targetOrgId}/users/${targetUserId}/${sourceKey.slice(prefix.length)}`;
  }
  const fileName = sourceKey.split('/').pop() || `file-${Date.now()}`;
  return `orgs/${targetOrgId}/users/${targetUserId}/cloned/${fileName}`;
}

async function copyS3ObjectBestEffort(
  sourceKey: string,
  targetKey: string,
): Promise<{ file_key: string; file_url: string } | null> {
  if (!env.S3_BUCKET || !sourceKey) {
    return null;
  }

  try {
    const client = getS3Client();
    await client.send(
      new CopyObjectCommand({
        Bucket: env.S3_BUCKET,
        CopySource: `${env.S3_BUCKET}/${sourceKey}`,
        Key: targetKey,
      }),
    );
    return {
      file_key: targetKey,
      file_url: buildS3PublicUrl(targetKey),
    };
  } catch (err) {
    logger.warn(
      { err, sourceKey, targetKey },
      'cross-org onboarding clone: S3 CopyObject failed; continuing without file',
    );
    return null;
  }
}

async function remapMaybeS3Url(params: {
  url?: string | null;
  keyHint?: string | null;
  sourceOrgId: string;
  sourceUserId: string;
  targetOrgId: string;
  targetUserId: string;
}): Promise<{ url: string | null; key: string | null }> {
  const { url, keyHint, sourceOrgId, sourceUserId, targetOrgId, targetUserId } = params;
  if (keyHint) {
    const newKey = mapS3Key(keyHint, sourceOrgId, sourceUserId, targetOrgId, targetUserId);
    const copied = await copyS3ObjectBestEffort(keyHint, newKey);
    if (copied) {
      return { url: copied.file_url, key: copied.file_key };
    }
  }
  return { url: url ?? null, key: null };
}

async function isKycFlowEnabledForOrg(orgId: string, trx?: Transaction): Promise<boolean> {
  const q = trx ? Organization.query(trx) : Organization.query();
  const organization = await q.select('id', 'kyc_flow_enabled').where('id', orgId).first();
  if (!organization) {
    return true;
  }
  return (organization as { kyc_flow_enabled?: boolean }).kyc_flow_enabled !== false;
}

function buildOnboardingCompliancePatch(
  payload: AdminHrOnboardingCompliancePayload,
): Partial<UserOnboarding> {
  const patch: Record<string, unknown> = {};
  const keys: (keyof AdminHrOnboardingCompliancePayload)[] = [
    'asset_device_pref',
    'asset_agreement_accepted',
    'device_serial_number',
    'policy_acknowledged',
    'offer_letter_signed',
    'offer_letter_url',
    'onboarding_status',
    'completed_at',
    'kyc_status',
    'kyc_failure_reason',
    'kyc_checked_at',
    'kyc_provider',
    'kyc_gating_exempt',
  ];
  for (const key of keys) {
    if (payload[key] !== undefined) {
      patch[key] = payload[key];
    }
  }
  return patch as Partial<UserOnboarding>;
}

async function ensureAndPatchOnboarding(
  userId: string,
  payload: AdminHrOnboardingCompliancePayload,
  trx?: Transaction,
): Promise<UserOnboarding> {
  const q = trx ? UserOnboarding.query(trx) : UserOnboarding.query();
  const patch = buildOnboardingCompliancePatch(payload);
  const existing = await q.findOne({ user_id: userId });

  if (!existing) {
    return (trx ? UserOnboarding.query(trx) : UserOnboarding.query()).insert({
      user_id: userId,
      asset_agreement_accepted: payload.asset_agreement_accepted ?? false,
      policy_acknowledged: payload.policy_acknowledged ?? false,
      offer_letter_signed: payload.offer_letter_signed ?? false,
      onboarding_status: payload.onboarding_status ?? 'IN_PROGRESS',
      kyc_status: payload.kyc_status ?? 'PENDING',
      ...patch,
    } as Partial<UserOnboarding>);
  }

  if (Object.keys(patch).length > 0) {
    return (trx ? UserOnboarding.query(trx) : UserOnboarding.query()).patchAndFetchById(
      existing.id,
      patch,
    );
  }
  return existing;
}

async function alignUserStatusFromOnboarding(
  userId: string,
  orgId: string,
  onboarding: Pick<UserOnboarding, 'kyc_status' | 'onboarding_status'>,
  trx?: Transaction,
): Promise<void> {
  const kycFlowEnabled = await isKycFlowEnabledForOrg(orgId, trx);
  const nextStatus = resolveUserStatusFromKycAndOnboarding({
    kycStatus: onboarding.kyc_status,
    onboardingStatus: onboarding.onboarding_status,
    kycFlowEnabled,
  });
  await (trx ? User.query(trx) : User.query()).patch({ status: nextStatus }).where({ id: userId });
}

async function remapSalaryBreakdown(
  breakdown: Record<string, number> | null | undefined,
  sourceOrgId: string,
  targetOrgId: string,
  trx?: Transaction,
): Promise<Record<string, number>> {
  if (!breakdown || typeof breakdown !== 'object') {
    return {};
  }

  const q = trx ? SalaryComponent.query(trx) : SalaryComponent.query();
  const [sourceComps, targetComps] = await Promise.all([
    q.clone().where({ org_id: sourceOrgId }).whereNull('deleted_at'),
    (trx ? SalaryComponent.query(trx) : SalaryComponent.query())
      .where({ org_id: targetOrgId })
      .whereNull('deleted_at'),
  ]);

  const sourceIdToCode = new Map(
    (sourceComps as SalaryComponent[]).map((c) => [String(c.id), c.code]),
  );
  const targetCodeToId = new Map(
    (targetComps as SalaryComponent[]).map((c) => [c.code, String(c.id)]),
  );

  const out: Record<string, number> = {};
  for (const [compId, amount] of Object.entries(breakdown)) {
    const code = sourceIdToCode.get(String(compId));
    if (!code) continue;
    const targetId = targetCodeToId.get(code);
    if (!targetId) continue;
    out[targetId] = amount;
  }
  return out;
}

/**
 * Validate whether a target role may be cloned from the source onboarding status.
 * Admin: any status. HR: source must be COMPLETED.
 */
export function assertAdminHrCrossOrgEligibility(
  targetRole: 'admin' | 'hr',
  sourceOnboardingStatus: string | null | undefined,
): void {
  if (targetRole === 'hr') {
    const status = String(sourceOnboardingStatus ?? '').toUpperCase();
    if (status !== 'COMPLETED') {
      throw new AdminHrCrossOrgEligibilityError(
        'HR cross-org sync requires the source admin/hr onboarding_status to be COMPLETED',
      );
    }
  }
}

/**
 * Full clone of admin/hr person + employment + compliance data onto a target org user.
 * Never copies department_id, manager_id, shift_id, or employee_id.
 */
export async function cloneAdminHrPersonData(
  input: CloneAdminHrPersonDataInput,
): Promise<CloneAdminHrPersonDataResult> {
  const { sourceUserId, sourceOrgId, targetUserId, targetOrgId, trx, syncMode = false } = input;

  if (!sourceUserId || !targetUserId || sourceUserId === targetUserId) {
    return { cloned: false };
  }

  const q = <T extends { query: (trx?: Transaction) => any }>(ModelClass: T) =>
    trx ? ModelClass.query(trx) : ModelClass.query();

  let clonedAnything = false;
  let passportPhotoKey: string | null = null;
  let copiedOfferLetterUrl: string | null = null;

  // User scalar fields (exclude dept/manager/shift/employee_id)
  const sourceUser = await q(User)
    .select('id', 'first_name', 'last_name', 'designation', 'date_of_joining', 'profile_image_url')
    .findById(sourceUserId);
  if (sourceUser) {
    let profile_image_url = sourceUser.profile_image_url ?? null;
    if (profile_image_url && typeof profile_image_url === 'string') {
      // Best-effort: if URL embeds source org/user path key pattern, leave URL as-is unless we have a key.
      // profile_image_url is typically a full URL without a separate key column.
    }
    await q(User)
      .patch({
        first_name: sourceUser.first_name,
        last_name: sourceUser.last_name,
        designation: sourceUser.designation,
        date_of_joining: sourceUser.date_of_joining,
        profile_image_url,
      } as Partial<User>)
      .where({ id: targetUserId });
    clonedAnything = true;
  }

  // Profile
  const sourceProfile = await q(UserProfile).findOne({ user_id: sourceUserId });
  if (sourceProfile) {
    const profilePayload = {
      user_id: targetUserId,
      gender: sourceProfile.gender,
      marital_status: sourceProfile.marital_status,
      dob: sourceProfile.dob,
      nationality: sourceProfile.nationality,
      personal_email: sourceProfile.personal_email,
      personal_phone: sourceProfile.personal_phone,
      alt_phone: sourceProfile.alt_phone,
      blood_group: sourceProfile.blood_group,
      emergency_contact_name: sourceProfile.emergency_contact_name,
      emergency_contact_phone: sourceProfile.emergency_contact_phone,
      permanent_address: sourceProfile.permanent_address,
      present_address: sourceProfile.present_address,
    };
    const existingTargetProfile = await q(UserProfile).findOne({ user_id: targetUserId });
    if (existingTargetProfile) {
      await q(UserProfile).patchAndFetchById(existingTargetProfile.id, profilePayload);
    } else {
      await q(UserProfile).insert(profilePayload);
    }
    clonedAnything = true;
  }

  // Addresses — replace
  const addresses = await q(Address).where({ user_id: sourceUserId });
  await q(Address).delete().where({ user_id: targetUserId });
  if (addresses.length) {
    await q(Address).insert(
      addresses.map((a: Address) => ({
        user_id: targetUserId,
        type: a.type,
        street_address: a.street_address,
        city: a.city,
        state: a.state,
        zip_code: a.zip_code,
        country: a.country,
      })),
    );
    clonedAnything = true;
  }

  // Emergency contacts — replace
  const contacts = await q(EmergencyContact).where({ user_id: sourceUserId });
  await q(EmergencyContact).delete().where({ user_id: targetUserId });
  if (contacts.length) {
    await q(EmergencyContact).insert(
      contacts.map((c: EmergencyContact) => ({
        user_id: targetUserId,
        name: c.name,
        relation: c.relation,
        phone: c.phone,
        email: c.email,
        is_primary: c.is_primary,
      })),
    );
    clonedAnything = true;
  }

  // Identities — upsert by id_type
  const sourceIdentities = await q(UserIdentity).where({ user_id: sourceUserId });
  for (const identity of sourceIdentities as UserIdentity[]) {
    const existing = await q(UserIdentity).findOne({
      user_id: targetUserId,
      id_type: identity.id_type,
    });
    const payload = {
      user_id: targetUserId,
      id_type: identity.id_type,
      id_number: identity.id_number,
      name_on_document: identity.name_on_document,
      valid_till: identity.valid_till,
    };
    if (existing) {
      await q(UserIdentity).patchAndFetchById(existing.id, payload);
    } else {
      await q(UserIdentity).insert(payload);
    }
    clonedAnything = true;
  }

  // Bank details
  const sourceBank = await q(BankDetail).findOne({ user_id: sourceUserId });
  if (sourceBank) {
    let bank_proof_url: string | null = sourceBank.bank_proof_url ?? null;
    let bank_proof_key: string | null = sourceBank.bank_proof_key ?? null;

    if (sourceBank.bank_proof_key) {
      const remapped = await remapMaybeS3Url({
        url: bank_proof_url,
        keyHint: sourceBank.bank_proof_key,
        sourceOrgId,
        sourceUserId,
        targetOrgId,
        targetUserId,
      });
      bank_proof_url = remapped.url;
      bank_proof_key = remapped.key;
    }

    const bankPayload: Record<string, unknown> = {
      user_id: targetUserId,
      account_holder_name: sourceBank.account_holder_name,
      account_number: sourceBank.account_number,
      ifsc_code: sourceBank.ifsc_code,
      bank_name: sourceBank.bank_name,
      branch_name: sourceBank.branch_name,
      account_type: sourceBank.account_type,
      bank_proof_url,
      bank_proof_key,
    };

    if (syncMode) {
      bankPayload.verification_status = sourceBank.verification_status ?? 'PENDING';
      bankPayload.verification_failure_reason = sourceBank.verification_failure_reason ?? null;
      bankPayload.verification_checked_at = sourceBank.verification_checked_at ?? null;
      bankPayload.verification_provider = sourceBank.verification_provider ?? null;
      bankPayload.verification_meta = sourceBank.verification_meta ?? null;
    } else {
      bankPayload.verification_status = 'PENDING';
      bankPayload.verification_failure_reason = null;
      bankPayload.verification_checked_at = null;
      bankPayload.verification_provider = null;
      bankPayload.verification_meta = null;
    }

    const existingBank = await q(BankDetail).findOne({ user_id: targetUserId });
    if (existingBank) {
      await q(BankDetail).patchAndFetchById(existingBank.id, bankPayload as any);
    } else {
      await q(BankDetail).insert(bankPayload as any);
    }
    clonedAnything = true;
  }

  // All documents (including employment pack) — upsert by doc_type
  const sourceDocs = await q(UserDocument).where({ user_id: sourceUserId });
  for (const doc of sourceDocs as UserDocument[]) {
    const docType = String(doc.doc_type ?? '').toUpperCase();
    let file_url = doc.file_url;
    let file_key = doc.file_key ?? null;

    if (doc.file_key) {
      const remapped = await remapMaybeS3Url({
        url: file_url,
        keyHint: doc.file_key,
        sourceOrgId,
        sourceUserId,
        targetOrgId,
        targetUserId,
      });
      file_url = remapped.url ?? file_url;
      file_key = remapped.key;
    }

    const existingDoc = await q(UserDocument).findOne({
      user_id: targetUserId,
      doc_type: doc.doc_type,
    });
    const docPayload = {
      user_id: targetUserId,
      doc_category: doc.doc_category,
      doc_type: doc.doc_type,
      file_url,
      file_key: file_key ?? undefined,
      verification_status: syncMode ? (doc.verification_status ?? 'PENDING') : 'PENDING',
      rejection_reason: syncMode ? doc.rejection_reason : undefined,
      uploaded_by: undefined,
      verification_meta: syncMode ? doc.verification_meta : undefined,
    };

    if (existingDoc) {
      await q(UserDocument).patchAndFetchById(existingDoc.id, docPayload as any);
    } else {
      await q(UserDocument).insert(docPayload as any);
    }

    if (LETTER_DOC_TYPES.has(docType) && file_url) {
      copiedOfferLetterUrl = file_url;
    }
    if (docType === 'PASSPORT_SIZE_PHOTO' && file_key) {
      passportPhotoKey = file_key;
    }
    clonedAnything = true;
  }

  // Full payroll details
  const sourcePayroll = await q(UserPayrollDetail).findOne({ user_id: sourceUserId });
  if (sourcePayroll) {
    const payrollPayload = {
      user_id: targetUserId,
      pan_number: sourcePayroll.pan_number,
      aadhaar_number: sourcePayroll.aadhaar_number,
      pf_number: sourcePayroll.pf_number,
      uan_number: sourcePayroll.uan_number,
      esi_number: sourcePayroll.esi_number,
      tax_saving_investments: sourcePayroll.tax_saving_investments,
      declared_tax: sourcePayroll.declared_tax,
    };
    const existingPayroll = await q(UserPayrollDetail).findOne({ user_id: targetUserId });
    if (existingPayroll) {
      await q(UserPayrollDetail).patchAndFetchById(existingPayroll.id, payrollPayload);
    } else {
      await q(UserPayrollDetail).insert(payrollPayload);
    }
    clonedAnything = true;
  }

  // Employment details
  const sourceEmployment = await q(EmployeeEmploymentDetail).findOne({ user_id: sourceUserId });
  if (sourceEmployment) {
    const employmentPayload = {
      user_id: targetUserId,
      employment_type: sourceEmployment.employment_type,
      work_mode: sourceEmployment.work_mode,
      base_salary: sourceEmployment.base_salary,
      annual_ctc: sourceEmployment.annual_ctc,
      currency: sourceEmployment.currency,
      notes: sourceEmployment.notes,
    };
    const existingEmployment = await q(EmployeeEmploymentDetail).findOne({
      user_id: targetUserId,
    });
    if (existingEmployment) {
      await q(EmployeeEmploymentDetail).patchAndFetchById(existingEmployment.id, employmentPayload);
    } else {
      await q(EmployeeEmploymentDetail).insert(employmentPayload);
    }
    clonedAnything = true;
  }

  // Benefits — replace by benefit_type upsert
  const sourceBenefits = await q(EmployeeBenefit).where({ user_id: sourceUserId });
  for (const benefit of sourceBenefits as EmployeeBenefit[]) {
    await q(EmployeeBenefit)
      .insert({
        user_id: targetUserId,
        benefit_type: benefit.benefit_type,
        enabled: benefit.enabled,
      })
      .onConflict(['user_id', 'benefit_type'])
      .merge({ enabled: benefit.enabled });
    clonedAnything = true;
  }

  // Salary structures — remap component ids by code
  const sourceStructures = await q(SalaryStructure)
    .where({ user_id: sourceUserId, org_id: sourceOrgId })
    .whereNull('deleted_at');
  if ((sourceStructures as SalaryStructure[]).length) {
    // Soft-delete existing target structures then insert remapped copies
    await q(SalaryStructure)
      .patch({ deleted_at: new Date(), is_active: false } as any)
      .where({ user_id: targetUserId, org_id: targetOrgId })
      .whereNull('deleted_at');

    for (const structure of sourceStructures as SalaryStructure[]) {
      const remappedBreakdown = await remapSalaryBreakdown(
        structure.component_breakdown,
        sourceOrgId,
        targetOrgId,
        trx,
      );
      await q(SalaryStructure).insert({
        user_id: targetUserId,
        org_id: targetOrgId,
        effective_from: structure.effective_from,
        effective_to: structure.effective_to,
        gross_salary: structure.gross_salary,
        net_salary: structure.net_salary,
        employer_total_contributions: structure.employer_total_contributions,
        component_breakdown: remappedBreakdown,
        notes: structure.notes,
        hike_percentage: structure.hike_percentage,
        is_active: structure.is_active,
      } as any);
      clonedAnything = true;
    }
  }

  // Onboarding assets / policy / signed / status / KYC
  const sourceOnboarding = await q(UserOnboarding).findOne({ user_id: sourceUserId });
  if (sourceOnboarding) {
    const offerLetterUrl = copiedOfferLetterUrl ?? sourceOnboarding.offer_letter_url ?? null;
    const onboardingPayload: AdminHrOnboardingCompliancePayload = {
      asset_device_pref: sourceOnboarding.asset_device_pref ?? null,
      asset_agreement_accepted: sourceOnboarding.asset_agreement_accepted,
      device_serial_number: sourceOnboarding.device_serial_number ?? null,
      policy_acknowledged: sourceOnboarding.policy_acknowledged,
      offer_letter_signed: sourceOnboarding.offer_letter_signed,
      offer_letter_url: offerLetterUrl,
      onboarding_status: sourceOnboarding.onboarding_status ?? 'IN_PROGRESS',
      completed_at: sourceOnboarding.completed_at ?? null,
      kyc_status: sourceOnboarding.kyc_status ?? null,
      kyc_failure_reason: sourceOnboarding.kyc_failure_reason ?? null,
      kyc_checked_at: sourceOnboarding.kyc_checked_at ?? null,
      kyc_provider: sourceOnboarding.kyc_provider ?? null,
      kyc_gating_exempt: sourceOnboarding.kyc_gating_exempt,
    };
    const targetOnboarding = await ensureAndPatchOnboarding(targetUserId, onboardingPayload, trx);
    await alignUserStatusFromOnboarding(targetUserId, targetOrgId, targetOnboarding, trx);
    clonedAnything = true;
  }

  if (passportPhotoKey && env.S3_BUCKET) {
    try {
      await indexUserFaceFromS3(targetOrgId, targetUserId, env.S3_BUCKET, passportPhotoKey);
    } catch (err) {
      logger.warn(
        { err, targetUserId, targetOrgId, passportPhotoKey },
        'cross-org onboarding clone: face re-index failed',
      );
    }
  }

  return { cloned: clonedAnything, passportPhotoKey };
}

/**
 * Resolve source admin/hr sibling and full-clone onto the target user.
 */
export async function cloneAdminHrPersonDataFromEmail(params: {
  email: string;
  targetUserId: string;
  targetOrgId: string;
  trx?: Transaction;
  syncMode?: boolean;
  /** When set, apply eligibility gate for this target role before cloning. */
  targetRole?: 'admin' | 'hr';
}): Promise<boolean> {
  const source = await findSourceAdminHrUser(params.email, {
    trx: params.trx,
    excludeOrgId: params.targetOrgId,
  });
  if (!source) {
    return false;
  }

  if (params.targetRole) {
    const onboarding = await (
      params.trx ? UserOnboarding.query(params.trx) : UserOnboarding.query()
    ).findOne({ user_id: source.id });
    assertAdminHrCrossOrgEligibility(params.targetRole, onboarding?.onboarding_status);
  }

  const result = await cloneAdminHrPersonData({
    sourceUserId: source.id,
    sourceOrgId: source.org_id,
    targetUserId: params.targetUserId,
    targetOrgId: params.targetOrgId,
    trx: params.trx,
    syncMode: params.syncMode,
  });

  return result.cloned;
}

/**
 * Continuously sync the full include set from a source admin/hr user to all siblings.
 */
export async function syncAdminHrFullByEmail(
  email: string,
  opts: SyncAdminHrFullOptions,
): Promise<number> {
  const emailNormalized = normalizeOfficialEmail(email);
  const userQ = opts.trx ? User.query(opts.trx) : User.query();

  let query = userQ
    .select('id', 'org_id', 'role', 'official_email')
    .whereRaw('LOWER(TRIM(official_email)) = ?', [emailNormalized])
    .whereIn('role', [...SWITCHABLE_ROLES])
    .whereNull('deleted_at');

  if (opts.exceptUserId) {
    query = query.whereNot('id', opts.exceptUserId);
  }

  const siblings = await query;
  if (!siblings.length) {
    return 0;
  }

  let synced = 0;
  for (const sibling of siblings) {
    if (!sibling.id || !sibling.org_id) continue;
    try {
      const result = await cloneAdminHrPersonData({
        sourceUserId: opts.sourceUserId,
        sourceOrgId: opts.sourceOrgId,
        targetUserId: sibling.id,
        targetOrgId: sibling.org_id,
        trx: opts.trx,
        syncMode: true,
      });
      if (result.cloned) {
        synced += 1;
      }
    } catch (err) {
      logger.warn(
        { err, siblingUserId: sibling.id, siblingOrgId: sibling.org_id, email: emailNormalized },
        'cross-org full sync failed for sibling',
      );
    }
  }

  return synced;
}

/**
 * If the user is admin/hr, full-sync their data to sibling orgs.
 */
export async function syncAdminHrFullForUserIfApplicable(params: {
  userId: string;
  orgId: string;
  role?: string | null;
  email?: string | null;
  trx?: Transaction;
}): Promise<number> {
  const { userId, orgId, trx } = params;
  let role = params.role;
  let email = params.email;

  if (!role || !email) {
    const user = await (trx ? User.query(trx) : User.query())
      .select('id', 'role', 'official_email')
      .findById(userId);
    if (!user) return 0;
    role = user.role;
    email = user.official_email;
  }

  if (!isAdminOrHrRole(role) || !email) {
    return 0;
  }

  return syncAdminHrFullByEmail(email, {
    exceptUserId: userId,
    sourceUserId: userId,
    sourceOrgId: orgId,
    trx,
  });
}

/** @deprecated Prefer syncAdminHrFullForUserIfApplicable — kept as alias for call-site compatibility. */
export async function syncAdminHrOnboardingComplianceForUserIfApplicable(params: {
  userId: string;
  orgId: string;
  role?: string | null;
  email?: string | null;
  trx?: Transaction;
  includeLetterDocs?: boolean;
}): Promise<number> {
  return syncAdminHrFullForUserIfApplicable(params);
}

export async function buildAdminHrOnboardingCompliancePayload(
  userId: string,
  orgId: string,
  opts?: { trx?: Transaction; includeLetterDocs?: boolean },
): Promise<AdminHrOnboardingCompliancePayload | null> {
  const trx = opts?.trx;
  const includeLetterDocs = opts?.includeLetterDocs !== false;
  const onboarding = await (trx ? UserOnboarding.query(trx) : UserOnboarding.query()).findOne({
    user_id: userId,
  });
  if (!onboarding) return null;

  const payload: AdminHrOnboardingCompliancePayload = {
    asset_device_pref: onboarding.asset_device_pref ?? null,
    asset_agreement_accepted: onboarding.asset_agreement_accepted,
    device_serial_number: onboarding.device_serial_number ?? null,
    policy_acknowledged: onboarding.policy_acknowledged,
    offer_letter_signed: onboarding.offer_letter_signed,
    offer_letter_url: onboarding.offer_letter_url ?? null,
    onboarding_status: onboarding.onboarding_status ?? null,
    completed_at: onboarding.completed_at ?? null,
    kyc_status: onboarding.kyc_status ?? null,
    kyc_failure_reason: onboarding.kyc_failure_reason ?? null,
    kyc_checked_at: onboarding.kyc_checked_at ?? null,
    kyc_provider: onboarding.kyc_provider ?? null,
    kyc_gating_exempt: onboarding.kyc_gating_exempt,
    sourceUserId: userId,
    sourceOrgId: orgId,
  };

  if (includeLetterDocs) {
    const docs = await (trx ? UserDocument.query(trx) : UserDocument.query()).where({
      user_id: userId,
    });
    payload.letterDocs = (docs as UserDocument[])
      .filter((d) => LETTER_DOC_TYPES.has(String(d.doc_type ?? '').toUpperCase()))
      .map((d) => ({
        doc_type: d.doc_type,
        doc_category: d.doc_category,
        file_url: d.file_url,
        file_key: d.file_key ?? null,
      }));
  }

  return payload;
}

/** @deprecated Prefer syncAdminHrFullByEmail. */
export async function syncAdminHrOnboardingComplianceByEmail(
  email: string,
  _payload: AdminHrOnboardingCompliancePayload,
  opts?: SyncAdminHrOnboardingComplianceOptions & {
    sourceUserId?: string;
    sourceOrgId?: string;
  },
): Promise<number> {
  if (!opts?.sourceUserId || !opts?.sourceOrgId) {
    return 0;
  }
  return syncAdminHrFullByEmail(email, {
    exceptUserId: opts.exceptUserId,
    sourceUserId: opts.sourceUserId,
    sourceOrgId: opts.sourceOrgId,
    trx: opts.trx,
  });
}

export type EnsureAndCloneAdminHrFromEmailResult = {
  cloned: boolean;
  created: boolean;
  user_id: string;
  password_reused: boolean;
  source_org_id: string;
  onboarding_status: string | null;
  role: 'admin' | 'hr';
};

/**
 * API entry: validate email + role, ensure user in target org, full-clone from source.
 */
export async function ensureAndCloneAdminHrFromEmail(params: {
  email: string;
  role: 'admin' | 'hr';
  targetOrgId: string;
  trx?: Transaction;
}): Promise<EnsureAndCloneAdminHrFromEmailResult> {
  const emailNormalized = normalizeOfficialEmail(params.email);
  if (!emailNormalized) {
    throw new AdminHrCrossOrgEligibilityError('email is required');
  }
  if (params.role !== 'admin' && params.role !== 'hr') {
    throw new AdminHrCrossOrgEligibilityError('role must be admin or hr');
  }

  const source = await findSourceAdminHrUser(emailNormalized, {
    trx: params.trx,
    excludeOrgId: params.targetOrgId,
  });
  if (!source) {
    throw new AdminHrCrossOrgNotFoundError(
      'No existing admin/hr account found for this email in another organization',
    );
  }

  const sourceOnboarding = await (
    params.trx ? UserOnboarding.query(params.trx) : UserOnboarding.query()
  ).findOne({ user_id: source.id });

  assertAdminHrCrossOrgEligibility(params.role, sourceOnboarding?.onboarding_status);

  const sourceUser = await (params.trx ? User.query(params.trx) : User.query())
    .select(
      'id',
      'first_name',
      'last_name',
      'password_hash',
      'must_change_password',
      'official_email',
    )
    .findById(source.id);
  if (!sourceUser?.password_hash) {
    throw new AdminHrCrossOrgNotFoundError('Source admin/hr credential is incomplete');
  }

  const existingTarget = await (params.trx ? User.query(params.trx) : User.query())
    .whereRaw('LOWER(TRIM(official_email)) = ?', [emailNormalized])
    .where({ org_id: params.targetOrgId })
    .whereNull('deleted_at')
    .first();

  let targetUserId: string;
  let created = false;

  if (existingTarget) {
    if (!isAdminOrHrRole(existingTarget.role)) {
      throw new AdminHrCrossOrgConflictError(
        'A non-admin/hr user with this email already exists in the current organization',
      );
    }
    targetUserId = existingTarget.id;
  } else {
    const runCreate = async (trx: Transaction) => {
      const roleRecord = await Roles.query(trx).where('name', params.role).first();
      if (!roleRecord) {
        throw new Error(`Role "${params.role}" not found in the database.`);
      }
      await assertOrganizationUserLimit(params.targetOrgId, roleRecord.name, trx);

      const inserted = await User.query(trx).insert({
        org_id: params.targetOrgId,
        employee_id: randomBytes(4).toString('hex'),
        first_name: sourceUser.first_name,
        last_name: sourceUser.last_name,
        official_email: emailNormalized,
        password_hash: sourceUser.password_hash,
        role: params.role,
        status: 'IN_PROGRESS',
        must_change_password: Boolean(sourceUser.must_change_password),
        department_id: null,
      } as any);

      await UserRole.query(trx).insert({
        user_id: inserted.id,
        role_id: roleRecord.id,
      });

      return inserted;
    };

    const createdUser = params.trx
      ? await runCreate(params.trx)
      : await User.transaction(runCreate);
    targetUserId = createdUser.id;
    created = true;
  }

  const cloned = await cloneAdminHrPersonData({
    sourceUserId: source.id,
    sourceOrgId: source.org_id,
    targetUserId,
    targetOrgId: params.targetOrgId,
    trx: params.trx,
    syncMode: false,
  });

  return {
    cloned: cloned.cloned,
    created,
    user_id: targetUserId,
    password_reused: true,
    source_org_id: source.org_id,
    onboarding_status: sourceOnboarding?.onboarding_status ?? null,
    role: params.role,
  };
}
