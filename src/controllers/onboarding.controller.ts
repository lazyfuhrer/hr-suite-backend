import type { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { UniqueViolationError } from 'db-errors';
import { ForeignKeyViolationError, Model } from 'objection';
import crypto from 'crypto';

import { Address } from '../models/Address';
import { BankDetail } from '../models/BankDetail';
import { Department } from '../models/Department';
import { EmergencyContact } from '../models/EmergencyContact';
import { EmployeeEmploymentDetail } from '../models/EmployeeEmploymentDetail';
import { EmployeeBenefit } from '../models/EmployeeBenefit';
import { SalaryComponent } from '../models/SalaryComponent';
import { SalaryStructure } from '../models/SalaryStructure';
import { DepartmentManager } from '../models/DepartmentManager';
import { UserDocument } from '../models/UserDocument';
import { UserIdentity } from '../models/UserIdentity';
import { UserOnboarding } from '../models/UserOnboarding';
import { UserPayrollDetail } from '../models/UserPayrollDetail';
import { UserProfile } from '../models/UserProfile';
import { User } from '../models/User';
import { LeaveType } from '../models/LeaveType';
import { LeaveRequest } from '../models/LeaveRequest';
import { AttendanceLog } from '../models/AttendanceLog';
import { AttendanceBreak } from '../models/AttendanceBreak';
import { AttendanceCorrectionRequest } from '../models/AttendanceCorrectionRequest';
import { Organization } from '../models/Organization';
import {
  fetchPrimaryManagedDepartmentScheduleByManagerIds,
  getManagedDepartmentIds,
} from '../utils/department-manager.utils';
import {
  applyDaySessionFactor,
  calculateEffectiveQuota,
  countLeaveDaysInRange,
  resolveLeaveScheduleForRow,
} from '../utils/leave.utils';
import { ensureFinanceItemComponent, normalizeFinanceItems } from '../utils/finance-items.utils';
import {
  DEFAULT_LATE_GRACE_PERIOD_MINS,
  getOrgLateGracePeriodMins,
} from '../utils/late-grace.utils';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { generateTempPassword } from '../utils/password.util';
import {
  assertOrganizationUserLimit,
  OrganizationUserLimitExceededError,
} from '../utils/organization-user-limit.utils';
import { buildS3PublicUrl, getS3Client } from '../utils/s3';
import {
  cleanupUploadedS3Keys,
  getPassportPhotoFaceIndexErrorResponse,
} from '../utils/passport-photo-face-index.utils';
import { generateCurrentMonthPayrollForUser } from '../services/auto-payroll.service';
import { indexUserFaceFromS3 } from '../services/face-recognition.service';
import {
  resolveOnboardingStatusFromComplianceAndKyc,
  triggerUserKycVerification,
} from '../services/reverseOnboardingKycTrigger.service';
import {
  AadhaarOtpRejectedError,
  sandboxGenerateAadhaarOtp,
  sandboxVerifyAadhaarOtp,
  sandboxVerifyPan,
  sandboxVerifyBankPennyLess,
} from '../services/sandboxAadhaar.service';
import {
  SandboxKycApiLogService,
  SANDBOX_KYC_API_KINDS,
  type SandboxKycApiKind,
} from '../services/sandbox-kyc-api-log.service';
import {
  formatDateLocal,
  getTodayDate,
  normalizeDate,
  parseTimeToMinutes,
  IST_OFFSET_MS,
} from '../utils/date.utils';
import {
  fetchEffectiveHolidayDateSet,
  shouldOmitAttendanceCalendarDate,
} from '../utils/attendance-schedule.utils';
import {
  onboardingStartSchema,
  onboardingFinanceSchema,
  onboardingDocumentSchema,
  onboardingDocumentsSchema,
  onboardingDocumentsSummaryQuerySchema,
  onboardingInProgressUsersQuerySchema,
  onboardingComplianceSchema,
  onboardingEmploymentSchema,
  onboardingBenefitsSchema,
  attendanceCalendarQuerySchema,
  onboardingAdminProfileUpdateSchema,
  onboardingBankAndAssetUpdateSchema,
  hasOnboardingBankAndAssetUpdateFields,
} from '../validators';
import { normalizeIndianPhone10Digits } from '../utils/phone.utils';
import { sendMsg91Email } from '../utils/msg91.utils';
import { uploadCancelledChequeForUser } from '../utils/s3Uploader';
import {
  hasEmployeeWelcomeEmailBeenSent,
  loadUserForWelcomeEmailLock,
  markEmployeeWelcomeEmailSent,
} from '../utils/employee-welcome-email.utils';
import {
  findExistingAdminHrCredential,
  isAdminOrHrRole,
  syncAdminHrPasswordByEmail,
} from '../utils/cross-org-admin-hr-password.utils';
import {
  cloneAdminHrPersonDataFromEmail,
  syncAdminHrOnboardingComplianceForUserIfApplicable,
  AdminHrCrossOrgEligibilityError,
} from '../services/cross-org-admin-hr-onboarding-clone.service';
import { OrganizationDocument } from '../models/OrganizationDocument';
import { OfficeLocation } from '../models/OfficeLocation';
import { UserAllowedLocation } from '../models/UserAllowedLocation';
import { REAL_EMPLOYEE_STATUSES } from '../constants/user-status';

const normalizeProfileGender = (value: unknown): 'MALE' | 'FEMALE' | 'OTHER' | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const raw = String(value).trim();
  if (raw.length === 0) return null;

  const alpha = raw.toUpperCase().replace(/[^A-Z]/g, '');
  if (alpha === 'MALE' || alpha === 'M') return 'MALE';
  if (alpha === 'FEMALE' || alpha === 'F') return 'FEMALE';
  if (alpha === 'OTHER' || alpha === 'O') return 'OTHER';

  // Common malformed values observed from clients, e.g. "FFEMALE".
  if (alpha.endsWith('FEMALE')) return 'FEMALE';
  if (alpha.endsWith('MALE')) return 'MALE';
  if (alpha.endsWith('OTHER')) return 'OTHER';

  return undefined;
};

export class OnboardingController {
  private static sanitizeMoney(input: number): number {
    if (!Number.isFinite(input)) return 0;
    // Keep up to 2 decimals before inserting into DECIMAL(12,2) columns.
    return Math.round(input * 100) / 100;
  }

  private static async isKycFlowEnabledForOrg(org_id: string): Promise<boolean> {
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

  private static async respondSandboxKycJson(
    req: Request,
    res: Response,
    apiKind: SandboxKycApiKind,
    httpStatus: number,
    body: Record<string, unknown>,
  ): Promise<Response> {
    await SandboxKycApiLogService.recordIfUser(req, apiKind, httpStatus, body);
    return res.status(httpStatus).json(body);
  }

  private static formatProfileAddress(a: Address | undefined) {
    if (!a) return null;
    return {
      id: String(a.id),
      user_id: String(a.user_id),
      address_type: a.type,
      street: a.street_address ?? null,
      city: a.city ?? null,
      state: a.state ?? null,
      postal_code: a.zip_code ?? null,
      country: a.country ?? null,
    };
  }

  private static buildProfileAddressesList(userId: string, addresses: Address[]) {
    const row = addresses.find((a) => a.type === 'PERMANENT');
    const formatted = OnboardingController.formatProfileAddress(row);
    if (formatted) return [formatted];
    return [
      {
        id: null,
        user_id: userId,
        address_type: 'PERMANENT' as const,
        street: null,
        city: null,
        state: null,
        postal_code: null,
        country: null,
      },
    ];
  }

  private static async hasAdminStepDocumentsComplete(
    org_id: string,
    user_id: string,
    trx?: any,
  ): Promise<boolean> {
    const documents = await UserDocument.query(trx)
      .where({ user_id })
      .select('uploaded_by', 'doc_type', 'doc_category');
    const uploaderIds = Array.from(
      new Set(
        documents
          .map((doc: any) => doc.uploaded_by)
          .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0),
      ),
    );
    if (uploaderIds.length === 0) return false;
    const privilegedUploaders = await User.query(trx)
      .whereIn('id', uploaderIds)
      .where('org_id', org_id)
      .whereIn('role', ['admin', 'hr'])
      .select('id', 'role');
    const privilegedUploaderIdSet = new Set(privilegedUploaders.map((u) => u.id));
    // NOTE: admin_step_completion.documents_complete is intended to represent
    // admin/hr uploading *employee documents* (not offer/joining letter artifacts).
    // Exclude offer/joining letter doc types from this completion check.
    const excludedDocTypes = new Set([
      'OFFER_LETTER',
      'OFFER_LETTER_URL',
      'SIGNED_JOINING_LETTER',
      'SIGNED_JOINING_LETTER_URL',
    ]);
    const hasPrivileged = documents.some((doc: any) => {
      const docType = String(doc?.doc_type ?? '').toUpperCase();
      if (excludedDocTypes.has(docType)) return false;
      return typeof doc.uploaded_by === 'string' && privilegedUploaderIdSet.has(doc.uploaded_by);
    });
    return hasPrivileged;
  }

  /**
   * Same rule as GET onboarding state `admin_step_completion.documents_complete`:
   * true if any document row has `uploaded_by` an admin/hr user in this org (no doc_type exclusions).
   * Used for mobile compliance welcome-email gating so it matches what the client shows.
   */
  private static async hasPrivilegedUploadedDocumentsForUser(
    org_id: string,
    user_id: string,
    trx?: any,
  ): Promise<boolean> {
    const documents = await UserDocument.query(trx).where({ user_id }).select('uploaded_by');
    const uploaderIds = Array.from(
      new Set(
        documents
          .map((doc: any) => doc.uploaded_by)
          .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0),
      ),
    );
    if (uploaderIds.length === 0) return false;
    const privilegedUploaders = await User.query(trx)
      .whereIn('id', uploaderIds)
      .where('org_id', org_id)
      .whereIn('role', ['admin', 'hr'])
      .select('id');
    const privilegedUploaderIdSet = new Set(privilegedUploaders.map((u) => u.id));
    return documents.some(
      (doc: any) =>
        typeof doc.uploaded_by === 'string' && privilegedUploaderIdSet.has(doc.uploaded_by),
    );
  }

  private static resolvePrimaryEmergencyContact(
    contacts: EmergencyContact[],
  ): EmergencyContact | null {
    if (!contacts.length) return null;
    return contacts.find((c) => c.is_primary) ?? contacts[0];
  }

  private static async resolveTargetUserId(req: Request, res: Response): Promise<string | null> {
    if (!req.user) {
      res.status(401).json({ message: 'Unauthorized' });
      return null;
    }

    const { userId } = req.params as { userId?: string };

    // Admin / HR can act on behalf of another user within same org when userId is provided
    if (userId && (req.user.role === 'admin' || req.user.role === 'hr')) {
      const target = await User.query()
        .where('id', userId)
        .where('org_id', req.user.org_id)
        .first();
      if (!target) {
        res.status(404).json({ message: 'User not found' });
        return null;
      }
      return target.id;
    }

    // Managers can act on behalf of users only within their managed departments
    if (userId && req.user.role === 'manager') {
      const target = await User.query()
        .where('id', userId)
        .where('org_id', req.user.org_id)
        .whereNull('deleted_at')
        .first();
      if (!target) {
        res.status(404).json({ message: 'User not found' });
        return null;
      }

      const managedDepartmentIds = await getManagedDepartmentIds(req.user.org_id, req.user.id);
      if (!target.department_id) {
        return target.id;
      }

      if (!managedDepartmentIds.includes(String(target.department_id))) {
        res.status(403).json({ message: 'Forbidden' });
        return null;
      }

      return target.id;
    }

    // For employees (or when no userId is provided), act on current user
    if (userId && userId !== req.user.id) {
      res.status(403).json({ message: 'Forbidden' });
      return null;
    }

    return req.user.id;
  }

  private static async verifyAndPersistBankKyc(params: {
    user_id: string;
    org_id: string;
    ifsc_code?: string;
    account_number?: string;
    account_holder_name?: string;
    mobile?: string;
  }): Promise<{
    status: 'VERIFIED' | 'FAILED' | 'PENDING';
    message: string;
    name_at_bank?: string;
    transaction_id?: string;
    account_exists?: boolean;
  }> {
    const { user_id } = params;
    const providerName = process.env.KYC_PROVIDER_NAME ?? 'sandbox';
    const existingBank = await BankDetail.query().findOne({ user_id });
    const finalIfsc = (params.ifsc_code ?? existingBank?.ifsc_code ?? '').trim().toUpperCase();
    const finalAccount = (params.account_number ?? existingBank?.account_number ?? '').trim();
    const finalName = (
      params.account_holder_name ??
      existingBank?.account_holder_name ??
      ''
    ).trim();

    // Ensure a bank_details row exists so verification patches are not no-ops.
    if (!existingBank) {
      await BankDetail.query().insert({
        user_id,
        ifsc_code: finalIfsc || null,
        account_number: finalAccount || null,
        account_holder_name: finalName || null,
      } as any);
    } else if (
      (finalIfsc && finalIfsc !== existingBank.ifsc_code) ||
      (finalAccount && finalAccount !== existingBank.account_number) ||
      (finalName && finalName !== existingBank.account_holder_name)
    ) {
      await BankDetail.query()
        .patch({
          ifsc_code: finalIfsc || existingBank.ifsc_code,
          account_number: finalAccount || existingBank.account_number,
          account_holder_name: finalName || existingBank.account_holder_name,
        } as any)
        .where({ user_id });
    }
    const bank = await BankDetail.query().findOne({ user_id });

    if (!finalIfsc || !finalAccount) {
      await BankDetail.query()
        .patch({
          verification_status: 'PENDING',
          verification_failure_reason: 'Waiting for bank account details',
          verification_checked_at: new Date().toISOString(),
          verification_provider: providerName,
          verification_meta: null,
        } as any)
        .where({ user_id });

      return { status: 'PENDING', message: 'Waiting for bank account details' };
    }

    await BankDetail.query()
      .patch({
        verification_status: 'IN_PROGRESS',
        verification_failure_reason: undefined,
        verification_checked_at: new Date().toISOString(),
        verification_provider: providerName,
      } as any)
      .where({ user_id });

    try {
      const result = await sandboxVerifyBankPennyLess({
        ifscCode: finalIfsc,
        accountNumber: finalAccount,
        name: finalName || undefined,
        mobile: params.mobile?.trim() || undefined,
      });

      if (result.account_exists) {
        await BankDetail.query()
          .patch({
            account_holder_name:
              bank?.account_holder_name ?? result.name_at_bank ?? bank?.account_holder_name,
            verification_status: 'VERIFIED',
            verification_failure_reason: undefined,
            verification_checked_at: new Date().toISOString(),
            verification_provider: providerName,
            verification_meta: {
              name_at_bank: result.name_at_bank ?? null,
              message: result.message ?? null,
              transaction_id: result.transaction_id ?? null,
            },
          } as any)
          .where({ user_id });

        return {
          status: 'VERIFIED',
          message: result.message ?? 'Bank account verified successfully',
          name_at_bank: result.name_at_bank,
          transaction_id: result.transaction_id,
          account_exists: true,
        };
      }

      await BankDetail.query()
        .patch({
          verification_status: 'FAILED',
          verification_failure_reason: result.message ?? 'Bank account could not be verified',
          verification_checked_at: new Date().toISOString(),
          verification_provider: providerName,
          verification_meta: {
            name_at_bank: result.name_at_bank ?? null,
            message: result.message ?? null,
            transaction_id: result.transaction_id ?? null,
          },
        } as any)
        .where({ user_id });

      return {
        status: 'FAILED',
        message: result.message ?? 'Bank account could not be verified',
        name_at_bank: result.name_at_bank,
        transaction_id: result.transaction_id,
        account_exists: false,
      };
    } catch (error: any) {
      const rawMessage = String(error?.message ?? 'Bank verification unavailable');
      const normalized = rawMessage.toLowerCase();
      const isTemporarilyUnavailable =
        normalized.includes('insufficient credits') ||
        normalized.includes('insufficient privilege') ||
        normalized.includes('source unavailable') ||
        normalized.includes('beneficiary bank offline');

      await BankDetail.query()
        .patch({
          verification_status: isTemporarilyUnavailable ? 'PENDING' : 'FAILED',
          verification_failure_reason: isTemporarilyUnavailable
            ? 'Bank verification temporarily unavailable'
            : rawMessage,
          verification_checked_at: new Date().toISOString(),
          verification_provider: providerName,
          verification_meta: { provider_error: rawMessage },
        } as any)
        .where({ user_id });

      return {
        status: isTemporarilyUnavailable ? 'PENDING' : 'FAILED',
        message: rawMessage,
        account_exists: false,
      };
    }
  }

  static async getState(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const user_id = await OnboardingController.resolveTargetUserId(req, res);
    if (!user_id) {
      return res as Response;
    }

    const user = await User.query().findById(user_id);

    const deptRowPromise =
      user?.department_id && req.user?.org_id
        ? Department.query()
            .where('org_id', req.user.org_id)
            .where('id', String(user.department_id))
            .select('id', 'name')
            .first()
        : Promise.resolve(null);

    const [
      profile,
      emergency_contacts,
      addresses,
      identities,
      bank_details,
      salary_structure,
      documents,
      onboarding,
      employment_details,
      benefit_rows,
      org_settings,
      departmentRow,
    ] = await Promise.all([
      UserProfile.query()
        .findOne({ user_id })
        .select(
          'gender',
          'marital_status',
          'dob',
          'nationality',
          'personal_email',
          'personal_phone',
          'alt_phone',
          'blood_group',
          'emergency_contact_name',
          'emergency_contact_phone',
        )
        .withGraphFetched('user(selectFields)')
        .modifiers({
          selectFields(builder) {
            builder.select(
              'first_name',
              'last_name',
              'official_email',
              'designation',
              'date_of_joining',
            );
          },
        }),
      EmergencyContact.query().where({ user_id }),
      Address.query().where({ user_id }),
      UserIdentity.query().where({ user_id }),
      BankDetail.query().findOne({ user_id }),
      SalaryStructure.query()
        .where({ user_id, is_active: true })
        .whereNull('deleted_at')
        .orderBy('effective_from', 'desc')
        .first(),
      UserDocument.query().where({ user_id }).orderBy('created_at', 'asc'),
      UserOnboarding.query().findOne({ user_id }),
      EmployeeEmploymentDetail.query().findOne({ user_id }),
      EmployeeBenefit.query().where({ user_id }),
      Organization.query().select('id', 'kyc_flow_enabled').where('id', req.user.org_id).first(),
      deptRowPromise,
    ]);

    const offerLetterComplete = Boolean(
      onboarding?.offer_letter_url || onboarding?.offer_letter_signed,
    );
    //     const complianceComplete = Boolean(
    //   onboarding?.policy_acknowledged &&
    //   onboarding?.offer_letter_signed
    // );
    // Keep this aligned with request validation:
    // nationality/personal_email/personal_phone/emergency_contacts/addresses are optional
    // at onboarding start time, so they should not block profile completion.

    // Define the list of fields you require
    const requiredProfileFields = [
      'gender',
      'marital_status',
      'dob',
      'nationality',
      'personal_email',
      'personal_phone',
      'blood_group',
    ];
    const missingProfileFields = requiredProfileFields.filter(
      (field) => !profile?.[field as keyof typeof profile],
    );
    const hasEmergencyContact = Boolean(
      (profile?.emergency_contact_name && profile?.emergency_contact_phone) ||
      emergency_contacts.some((c) => c.name && c.phone),
    );
    if (!hasEmergencyContact) {
      missingProfileFields.push('emergency_contact');
    }
    if (!profile?.user?.first_name) missingProfileFields.push('user.first_name');
    if (!profile?.user?.official_email) missingProfileFields.push('user.official_email');
    if (missingProfileFields.length > 0) {
      logger.warn({ missingProfileFields }, 'Profile Incomplete. Missing fields');
    }

    const profileComplete = missingProfileFields.length === 0 && addresses.length > 0;

    // When org-level KYC gating is disabled, Aadhaar/PAN uploads are not mandatory
    // for onboarding step completion. Keep existing behavior for KYC-enabled orgs.
    const kycFlowEnabled = (org_settings as any)?.kyc_flow_enabled !== false;
    const mandatoryDocTypes = kycFlowEnabled
      ? ['AADHAR_FRONT', 'AADHAR_BACK', 'PAN_CARD', 'PASSPORT_SIZE_PHOTO']
      : ['PASSPORT_SIZE_PHOTO'];

    const missingDocs = mandatoryDocTypes.filter(
      (type) => !documents.some((doc) => doc.doc_type === type),
    );

    const documents_upload_completed = missingDocs.length === 0;

    if (!documents_upload_completed) {
      logger.warn({ missingDocs }, 'Missing documents');
      //console.log('📄 Missing documents:', missingDocs);
    }

    const bankAssetFieldsSet = Boolean(bank_details?.ifsc_code && bank_details?.account_number);
    const complianceComplete = Boolean(
      onboarding?.policy_acknowledged && onboarding?.offer_letter_signed,
    );
    const allowances =
      benefit_rows.length > 0
        ? {
            transportation:
              benefit_rows.find((b) => b.benefit_type === 'ALLOWANCE_TRANSPORT')?.enabled ?? false,
            meal: benefit_rows.find((b) => b.benefit_type === 'ALLOWANCE_MEAL')?.enabled ?? false,
            internet:
              benefit_rows.find((b) => b.benefit_type === 'ALLOWANCE_INTERNET')?.enabled ?? false,
          }
        : undefined;

    const benefitsSummary =
      benefit_rows.length > 0
        ? {
            health_insurance:
              benefit_rows.find((b) => b.benefit_type === 'BENEFIT_HEALTH_INSURANCE')?.enabled ??
              false,
            life_insurance:
              benefit_rows.find((b) => b.benefit_type === 'BENEFIT_LIFE_INSURANCE')?.enabled ??
              false,
            company_device:
              benefit_rows.find((b) => b.benefit_type === 'BENEFIT_COMPANY_DEVICE')?.enabled ??
              false,
            training_program:
              benefit_rows.find((b) => b.benefit_type === 'BENEFIT_TRAINING')?.enabled ?? false,
            tuition:
              benefit_rows.find((b) => b.benefit_type === 'BENEFIT_TUITION')?.enabled ?? false,
            fitness_membership:
              benefit_rows.find((b) => b.benefit_type === 'BENEFIT_FITNESS')?.enabled ?? false,
            mental_health_support:
              benefit_rows.find((b) => b.benefit_type === 'BENEFIT_MENTAL_HEALTH_SUPPORT')
                ?.enabled ?? false,
          }
        : undefined;

    const step_completion = {
      profile_complete: profileComplete,
      documents_upload_completed: documents_upload_completed,
      bank_and_asset_complete: bankAssetFieldsSet,
      compliance_complete: complianceComplete,

      finance_complete: Boolean(salary_structure) || Boolean(employment_details?.annual_ctc),
      documents_complete: documents.length > 0,
      asset_compliance_complete: offerLetterComplete,
      employment_complete: Boolean(employment_details),
      benefits_complete: benefit_rows.length > 0,
    };
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
        .where('org_id', req.user.org_id)
        .whereIn('role', ['admin', 'hr'])
        .select('id');
      privilegedUploaderIdSet = new Set(privilegedUploaders.map((u) => u.id));
    }
    const hasPrivilegedUploadedDocuments = documents.some(
      (doc: any) =>
        typeof doc.uploaded_by === 'string' && privilegedUploaderIdSet.has(doc.uploaded_by),
    );
    const admin_step_completion = {
      documents_complete: hasPrivilegedUploadedDocuments,
    };

    const document_verification_summary = documents.map((doc) => ({
      id: doc.id,
      doc_category: doc.doc_category,
      doc_type: doc.doc_type,
      verification_status: doc.verification_status,
      rejection_reason: doc.rejection_reason,
    }));

    const profilePayload = profile ?? {
      gender: null,
      marital_status: null,
      dob: null,
      nationality: null,
      personal_email: null,
      personal_phone: null,
      alt_phone: null,
      blood_group: null,
      emergency_contact_name: null,
      emergency_contact_phone: null,
      emergency_contact_relation: null,
      user: {
        first_name: user?.first_name ?? null,
        last_name: user?.last_name ?? null,
        official_email: user?.official_email ?? null,
        designation: user?.designation ?? null,
        date_of_joining: user?.date_of_joining ?? null,
      },
    };

    // The `dob` column is a DATE, but pg/objection can return it as a JS Date.
    // Serializing with ISO (UTC) can shift the calendar day (e.g., 2001-12-21 -> 2001-12-20T18:30Z).
    // For UI correctness, return a date-only string (YYYY-MM-DD) without timezone shifting.
    const formatDobOnly = (value: Date | string | null | undefined): string | null => {
      if (!value) return null;
      const d = typeof value === 'string' ? new Date(value) : value;
      if (Number.isNaN(d.getTime())) return null;
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };

    if (profilePayload && (profilePayload as any).dob) {
      const dobValue: any = (profilePayload as any).dob;
      const localDob = formatDobOnly(dobValue);

      (profilePayload as any).dob = localDob;
    }

    const primaryEmergency =
      OnboardingController.resolvePrimaryEmergencyContact(emergency_contacts);
    if (primaryEmergency) {
      (profilePayload as any).emergency_contact_name =
        primaryEmergency.name ?? (profilePayload as any).emergency_contact_name ?? null;
      (profilePayload as any).emergency_contact_phone =
        primaryEmergency.phone ?? (profilePayload as any).emergency_contact_phone ?? null;
      (profilePayload as any).emergency_contact_relation = primaryEmergency.relation ?? null;
    } else if ((profilePayload as any).emergency_contact_relation === undefined) {
      (profilePayload as any).emergency_contact_relation = null;
    }

    return res.json({
      employee_id: user?.employee_id,
      department: departmentRow
        ? { id: (departmentRow as any).id, name: (departmentRow as any).name }
        : null,
      org_settings: {
        kyc_flow_enabled: (org_settings as any)?.kyc_flow_enabled !== false,
        company_device: benefitsSummary?.company_device ?? false,
      },
      profile: profilePayload,
      emergency_contacts,
      addresses,
      identities,
      bank_details,
      salary_structure,
      documents,
      onboarding,
      employment_details,
      benefits:
        allowances || benefitsSummary
          ? {
              allowances,
              benefits: benefitsSummary,
            }
          : undefined,
      step_completion,
      admin_step_completion,
      kyc: onboarding
        ? {
            status: onboarding.kyc_status ?? 'NOT_REQUIRED',
            failure_reason: onboarding.kyc_failure_reason ?? null,
            checked_at: onboarding.kyc_checked_at ?? null,
            provider: onboarding.kyc_provider ?? null,
          }
        : undefined,
      document_verification_summary,
    });
  }

  /**
   * Generate Aadhaar OTP via Sandbox for the current user.
   * Intended for mobile onboarding: user enters Aadhaar, receives OTP on Aadhaar-linked mobile.
   */
  static async generateAadhaarOtp(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return OnboardingController.respondSandboxKycJson(req, res, 'aadhaar_otp', 401, {
        message: 'Unauthorized',
      });
    }

    const { aadhaarNumber, aadhaar_number, consent, reason } = req.body as {
      aadhaarNumber?: string;
      aadhaar_number?: string;
      consent?: string;
      reason?: string;
    };

    const aadhaarInput = aadhaarNumber ?? aadhaar_number;
    if (!aadhaarInput || typeof aadhaarInput !== 'string') {
      return OnboardingController.respondSandboxKycJson(req, res, 'aadhaar_otp', 400, {
        message: 'aadhaarNumber is required',
      });
    }

    const finalAadhaarNumber = aadhaarInput.trim();
    if (!/^\d{12}$/.test(finalAadhaarNumber)) {
      return OnboardingController.respondSandboxKycJson(req, res, 'aadhaar_otp', 400, {
        message: 'aadhaarNumber must be a 12-digit number',
      });
    }

    try {
      const { reference_id, message } = await sandboxGenerateAadhaarOtp({
        aadhaarNumber: finalAadhaarNumber,
        consent: consent?.toLowerCase() === 'y' ? 'y' : 'Y',
        reason: reason || 'Employee onboarding Aadhaar KYC',
      });

      // Upsert Aadhaar identity record for this user
      const existing = await UserIdentity.query()
        .where({ user_id: req.user.id, id_type: 'AADHAAR' })
        .first();

      if (existing) {
        await UserIdentity.query()
          .patch({ id_number: finalAadhaarNumber })
          .where({ id: existing.id });
      } else {
        await UserIdentity.query().insert({
          user_id: req.user.id,
          id_type: 'AADHAAR',
          id_number: finalAadhaarNumber,
        });
      }

      return OnboardingController.respondSandboxKycJson(req, res, 'aadhaar_otp', 200, {
        reference_id,
        message,
        aadhaar_number: finalAadhaarNumber,
      });
    } catch (error: any) {
      if (error instanceof AadhaarOtpRejectedError) {
        return OnboardingController.respondSandboxKycJson(req, res, 'aadhaar_otp', 422, {
          reference_id: error.referenceId,
          message: error.providerMessage,
          aadhaar_number: finalAadhaarNumber,
        });
      }

      const rawMessage = error?.message ?? 'Unknown error';
      const normalized = String(rawMessage).toLowerCase();

      if (normalized.includes('insufficient privilege')) {
        return OnboardingController.respondSandboxKycJson(req, res, 'aadhaar_otp', 503, {
          status: 'unavailable',
          message: 'Aadhaar OTP service is temporarily unavailable for current API credentials.',
          provider_error: rawMessage,
        });
      }

      return OnboardingController.respondSandboxKycJson(req, res, 'aadhaar_otp', 502, {
        message: 'Failed to generate Aadhaar OTP',
        error: rawMessage,
      });
    }
  }

  /**
   * Verify Aadhaar OTP via Sandbox for the current user.
   * Expects referenceId from generate-OTP step and the OTP entered by the user.
   */
  static async verifyAadhaarOtp(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return OnboardingController.respondSandboxKycJson(req, res, 'aadhaar_verify_otp', 401, {
        message: 'Unauthorized',
      });
    }

    const { referenceId, otp } = req.body as {
      referenceId?: string;
      otp?: string;
    };

    if (!referenceId || !otp) {
      return OnboardingController.respondSandboxKycJson(req, res, 'aadhaar_verify_otp', 400, {
        message: 'referenceId and otp are required',
      });
    }

    try {
      const result = await sandboxVerifyAadhaarOtp({
        referenceId: referenceId,
        otp,
      });

      // On VALID Aadhaar, attach verified name to the Aadhaar identity record if present
      if (result.status === 'VALID') {
        const existing = await UserIdentity.query()
          .where({ user_id: req.user.id, id_type: 'AADHAAR' })
          .first();

        if (existing) {
          await UserIdentity.query()
            .patch({
              name_on_document: result.name ?? existing.name_on_document,
            })
            .where({ id: existing.id });
        }

        // Automatically re-run KYC after Aadhaar success so kyc_status can move
        // while onboarding is still IN_PROGRESS.
        if (req.user.org_id) {
          try {
            await triggerUserKycVerification(req.user.org_id, req.user.id);
          } catch (err) {
            logger.error(
              { err, user_id: req.user?.id, org_id: req.user?.org_id },
              'Failed to trigger KYC after Aadhaar OTP verification',
            );
          }
        }
      }

      const payload = {
        status: result.status,
        message: result.message,
        name: result.name,
        date_of_birth: result.date_of_birth,
        gender: result.gender,
        full_address: result.full_address,
      };

      if (result.status === 'VALID') {
        return OnboardingController.respondSandboxKycJson(
          req,
          res,
          'aadhaar_verify_otp',
          200,
          payload,
        );
      }

      return OnboardingController.respondSandboxKycJson(
        req,
        res,
        'aadhaar_verify_otp',
        422,
        payload,
      );
    } catch (error: any) {
      const rawMessage = error?.message ?? 'Unknown error';
      const normalized = String(rawMessage).toLowerCase();

      // Sandbox often returns 200 with a message, but we surface some provider-side
      // states (invalid/expired/under process) as non-502 responses for better UX.
      if (normalized.includes('invalid otp')) {
        return OnboardingController.respondSandboxKycJson(req, res, 'aadhaar_verify_otp', 422, {
          status: 'INVALID',
          message: 'Invalid OTP',
          provider_error: rawMessage,
        });
      }
      if (normalized.includes('otp expired')) {
        return OnboardingController.respondSandboxKycJson(req, res, 'aadhaar_verify_otp', 422, {
          status: 'INVALID',
          message: 'OTP expired. Please generate a new OTP.',
          provider_error: rawMessage,
        });
      }
      if (normalized.includes('request under process')) {
        return OnboardingController.respondSandboxKycJson(req, res, 'aadhaar_verify_otp', 503, {
          status: 'PENDING',
          message: 'Request under process. Please retry after a few seconds.',
          provider_error: rawMessage,
        });
      }
      if (normalized.includes('invalid reference')) {
        return OnboardingController.respondSandboxKycJson(req, res, 'aadhaar_verify_otp', 400, {
          message: 'Invalid referenceId',
          provider_error: rawMessage,
        });
      }
      if (normalized.includes('insufficient credits')) {
        return OnboardingController.respondSandboxKycJson(req, res, 'aadhaar_verify_otp', 503, {
          status: 'unavailable',
          message: 'Aadhaar verification is temporarily unavailable. Please try again later.',
          provider_error: rawMessage,
        });
      }

      return OnboardingController.respondSandboxKycJson(req, res, 'aadhaar_verify_otp', 502, {
        message: 'Failed to verify Aadhaar OTP',
        error: rawMessage,
      });
    }
  }

  /**
   * Verify PAN via Sandbox for the current user.
   * Single-step API (no OTP) that verifies PAN details against name and DOB.
   */
  static async verifyPan(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return OnboardingController.respondSandboxKycJson(req, res, 'pan_verify', 401, {
        message: 'Unauthorized',
      });
    }

    const { pan, name, date_of_birth, reason } = req.body as {
      pan?: string;
      name?: string;
      date_of_birth?: string; // YYYY-MM-DD from client
      reason?: string;
    };

    if (!pan || !name || !date_of_birth) {
      return OnboardingController.respondSandboxKycJson(req, res, 'pan_verify', 400, {
        message: 'pan, name, and date_of_birth are required fields',
      });
    }

    const trimmedPan = pan.trim().toUpperCase();
    // Basic PAN format check as per Sandbox docs
    const panRegex = /^[A-Z]{3}[PCFTGHLABJ][A-Z][0-9]{4}[A-Z]$/;
    if (!panRegex.test(trimmedPan)) {
      return OnboardingController.respondSandboxKycJson(req, res, 'pan_verify', 400, {
        message: 'Invalid PAN format',
      });
    }

    // Convert YYYY-MM-DD -> DD/MM/YYYY for Sandbox
    const dobParts = date_of_birth.split('-');
    if (dobParts.length !== 3) {
      return OnboardingController.respondSandboxKycJson(req, res, 'pan_verify', 400, {
        message: 'date_of_birth must be in YYYY-MM-DD format',
      });
    }
    const [year, month, day] = dobParts;
    const dobForSandbox = `${day}/${month}/${year}`;

    try {
      const result = await sandboxVerifyPan({
        pan: trimmedPan,
        nameAsPerPan: name,
        dateOfBirth: dobForSandbox,
        consent: 'Y',
        reason: reason || 'Employee onboarding PAN verification',
      });

      const panVerified =
        result.status === 'valid' && result.name_match === true && result.dob_match === true;

      const payload = {
        status: result.status,
        message: result.message,
        name_match: result.name_match,
        dob_match: result.dob_match,
      };

      if (panVerified) {
        const existing = await UserIdentity.query()
          .where({ user_id: req.user.id, id_type: 'PAN' })
          .first();

        if (existing) {
          await UserIdentity.query()
            .patch({
              id_number: trimmedPan,
              name_on_document: name,
            })
            .where({ id: existing.id });
        } else {
          await UserIdentity.query().insert({
            user_id: req.user.id,
            id_type: 'PAN',
            id_number: trimmedPan,
            name_on_document: name,
          });
        }

        // Automatically re-run KYC after PAN success to incorporate PAN into
        // overall KYC decision while onboarding is IN_PROGRESS.
        if (req.user.org_id) {
          try {
            await triggerUserKycVerification(req.user.org_id, req.user.id);
          } catch (err) {
            logger.error(
              { err, user_id: req.user?.id, org_id: req.user?.org_id },
              'Failed to trigger KYC after PAN verification',
            );
          }
        }

        return OnboardingController.respondSandboxKycJson(req, res, 'pan_verify', 200, payload);
      }

      return OnboardingController.respondSandboxKycJson(req, res, 'pan_verify', 422, payload);
    } catch (error: any) {
      const rawMessage = error?.message ?? 'Unknown error';
      const normalized = String(rawMessage).toLowerCase();

      if (
        normalized.includes('insufficient credits') ||
        normalized.includes('insufficient privilege')
      ) {
        return OnboardingController.respondSandboxKycJson(req, res, 'pan_verify', 503, {
          status: 'unavailable',
          message: 'PAN verification is temporarily unavailable. Please try again later.',
          provider_error: rawMessage,
        });
      }

      return OnboardingController.respondSandboxKycJson(req, res, 'pan_verify', 502, {
        message: 'Failed to verify PAN',
        error: rawMessage,
      });
    }
  }

  /**
   * Verify bank account via Sandbox penny-less API for current user.
   * This endpoint can be used explicitly, while KYC trigger also verifies bank
   * automatically using saved bank_details.
   */
  static async verifyBankAccount(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return OnboardingController.respondSandboxKycJson(req, res, 'bank_verify', 401, {
        message: 'Unauthorized',
      });
    }

    const {
      ifsc_code,
      account_number,
      account_holder_name,
      mobile,
    }: {
      ifsc_code?: string;
      account_number?: string;
      account_holder_name?: string;
      mobile?: string;
    } = req.body ?? {};

    try {
      const result = await OnboardingController.verifyAndPersistBankKyc({
        user_id: req.user.id,
        org_id: req.user.org_id,
        ifsc_code,
        account_number,
        account_holder_name,
        mobile,
      });

      // Re-run full KYC so bank check is applied while onboarding is IN_PROGRESS.
      if (req.user.org_id) {
        try {
          await triggerUserKycVerification(req.user.org_id, req.user.id);
        } catch (err) {
          logger.error(
            { err, user_id: req.user?.id, org_id: req.user?.org_id },
            'Failed to trigger KYC after bank verification',
          );
        }
      }

      const accountExists = result.account_exists === true;
      const status =
        accountExists && result.status === 'VERIFIED'
          ? 'VERIFIED'
          : result.status === 'PENDING'
            ? 'PENDING'
            : 'FAILED';

      const payload = {
        status,
        account_exists: accountExists,
        name_at_bank: result.name_at_bank ?? null,
        message: result.message,
        transaction_id: result.transaction_id ?? null,
      };

      if (status === 'VERIFIED') {
        return OnboardingController.respondSandboxKycJson(req, res, 'bank_verify', 200, payload);
      }
      if (status === 'FAILED') {
        return OnboardingController.respondSandboxKycJson(req, res, 'bank_verify', 422, payload);
      }
      // PENDING
      if (result.message === 'Waiting for bank account details') {
        return OnboardingController.respondSandboxKycJson(req, res, 'bank_verify', 400, payload);
      }
      return OnboardingController.respondSandboxKycJson(req, res, 'bank_verify', 503, payload);
    } catch (error: any) {
      const rawMessage = error?.message ?? 'Unknown error';
      const normalized = String(rawMessage).toLowerCase();

      if (
        normalized.includes('insufficient credits') ||
        normalized.includes('insufficient privilege') ||
        normalized.includes('source unavailable') ||
        normalized.includes('beneficiary bank offline')
      ) {
        return OnboardingController.respondSandboxKycJson(req, res, 'bank_verify', 503, {
          status: 'unavailable',
          message: 'Bank verification is temporarily unavailable. Please try again later.',
          provider_error: rawMessage,
        });
      }

      return OnboardingController.respondSandboxKycJson(req, res, 'bank_verify', 502, {
        message: 'Failed to verify bank account',
        error: rawMessage,
      });
    }
  }

  /**
   * Admin: list stored Sandbox KYC API responses (Aadhaar OTP, verify-otp, PAN, bank) for the org.
   */
  static async listSandboxKycLogs(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    if (!req.user.org_id) {
      return res.status(403).json({ message: 'Organization context required' });
    }

    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));
    const user_id = typeof req.query.user_id === 'string' ? req.query.user_id : undefined;
    const api_kind_raw = typeof req.query.api_kind === 'string' ? req.query.api_kind.trim() : '';
    const allowedKinds = new Set<string>(Object.values(SANDBOX_KYC_API_KINDS));
    if (api_kind_raw && !allowedKinds.has(api_kind_raw)) {
      return res.status(400).json({
        message: 'Invalid api_kind',
        allowed: Array.from(allowedKinds),
      });
    }

    const data = await SandboxKycApiLogService.listForOrgAdmin({
      org_id: req.user.org_id,
      page,
      limit,
      user_id,
      api_kind: (api_kind_raw || undefined) as SandboxKycApiKind | undefined,
    });

    return res.json(data);
  }

  /**
   * Admin / HR: Get detailed employee profile including contacts & addresses.
   * Response shape is fixed to match the consumer exactly.
   */
  static async getEmployeeProfileAdmin(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { userId } = req.params as { userId?: string };
    if (!userId) {
      return res.status(400).json({ message: 'userId is required' });
    }

    const org_id = req.user.org_id;

    const user = await User.query()
      .where('org_id', org_id)
      .where('id', userId)
      .whereNull('deleted_at')
      .first();

    if (!user) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const [profile, emergency_contacts, addresses, employmentDetails] = await Promise.all([
      UserProfile.query().findOne({ user_id: user.id }),
      EmergencyContact.query().where({ user_id: user.id }),
      Address.query().where({ user_id: user.id }),
      EmployeeEmploymentDetail.query().findOne({ user_id: user.id }),
    ]);

    const formatDate = (value: Date | string | null | undefined): string | null => {
      if (!value) return null;
      const d = typeof value === 'string' ? new Date(value) : value;
      if (Number.isNaN(d.getTime())) return null;

      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const localDobOnly = `${y}-${m}-${day}`;

      return localDobOnly;
    };

    const data = {
      user_id: String(user.id),
      employee_id: user.employee_id ?? null,
      first_name: user.first_name ?? null,
      last_name: user.last_name ?? null,
      official_email: user.official_email ?? null,
      personal_email: profile?.personal_email ?? null,
      phone_number: profile?.personal_phone ?? null,
      alternate_phone_number: profile?.alt_phone ?? null,
      date_of_birth: formatDate(profile?.dob),
      gender: profile?.gender ?? null,
      marital_status: profile?.marital_status ?? null,
      blood_group: profile?.blood_group ?? null,
      nationality: profile?.nationality ?? null,
      designation: user.designation ?? null,
      date_of_joining: formatDate(user.date_of_joining as any),
      employment_type: employmentDetails?.employment_type ?? null,
      work_mode: employmentDetails?.work_mode ?? null,
      emergency_contacts: emergency_contacts.map((c) => ({
        id: String(c.id),
        user_id: String(c.user_id),
        name: c.name,
        relationship: (c as any).relation ?? null,
        phone_number: (c as any).phone ?? null,
        email: c.email ?? null,
      })),
      addresses: OnboardingController.buildProfileAddressesList(String(user.id), addresses),
    };

    return res.json({
      message: 'Profile retrieved successfully',
      data,
    });
  }

  /**
   * All-org-members composite endpoint for a user profile overview.
   *
   * Intended to back the About / Work / Doc style profile screen:
   * - about: personal + contact information
   * - work: job details, reporting manager, team summary, primary work location
   * - documents: flat list of recent documents (identity, education, experience, etc.)
   *
   * Access:
   * - admin/hr can view any user in the same org (via :userId)
   * - manager/employee can view only their own profile (enforced via resolveTargetUserId)
   */
  static async getEmployeeOverview(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const targetUserId = await OnboardingController.resolveTargetUserId(req, res);
    if (!targetUserId) {
      return res as Response;
    }

    const org_id = req.user.org_id;

    const user = await User.query()
      .withGraphJoined('[profile, employmentDetails]')
      .where('users.org_id', org_id)
      .where('users.id', targetUserId)
      .whereNull('users.deleted_at')
      .select(
        'users.id',
        'users.org_id',
        'users.employee_id',
        'users.first_name',
        'users.last_name',
        'users.official_email',
        'users.role',
        'users.status',
        'users.department_id',
        'users.designation',
        'users.date_of_joining',
        'users.profile_image_url',
      )
      .first();

    if (!user) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const userWithRelations = user as any;

    const deptId = user.department_id;

    const managedDeptRows =
      user.role === 'manager'
        ? await DepartmentManager.query()
            .where('manager_id', user.id)
            .select('department_id')
            .orderBy('created_at', 'asc')
        : [];

    const associatedDepartmentIds = Array.from(
      new Set(
        [
          deptId ? String(deptId) : null,
          ...(managedDeptRows as any[]).map((r) => r.department_id).filter(Boolean),
        ].filter(Boolean) as string[],
      ),
    );

    const associatedDepartmentsFull =
      associatedDepartmentIds.length > 0
        ? await Department.query()
            .where('org_id', org_id)
            .whereIn('id', associatedDepartmentIds)
            .select('id', 'name', 'manager_id', 'location_id', 'location_ids')
            .orderBy('name', 'asc')
        : [];

    const departmentLocationIds = Array.from(
      new Set(
        (associatedDepartmentsFull as any[]).flatMap((d) => {
          if (Array.isArray(d.location_ids) && d.location_ids.length > 0) {
            return d.location_ids.filter((id: unknown): id is string => typeof id === 'string');
          }
          return d.location_id ? [String(d.location_id)] : [];
        }),
      ),
    );

    const departmentManagerIdsRows =
      associatedDepartmentIds.length > 0
        ? await DepartmentManager.query()
            .whereIn('department_id', associatedDepartmentIds)
            .select('department_id', 'manager_id')
            .orderBy('created_at', 'asc')
        : [];

    const managerIds = Array.from(
      new Set(
        [
          ...(associatedDepartmentsFull as any[])
            .map((d) => (d.manager_id ? String(d.manager_id) : null))
            .filter(Boolean),
          ...((departmentManagerIdsRows as any[])
            .map((r) => r.manager_id)
            .filter(Boolean) as string[]),
        ].filter(Boolean) as string[],
      ),
    );

    const includePendingRequests = user.role === 'manager' || user.role === 'hr';

    const knex = User.knex();
    const viewerUserId = req.user.id;

    const [
      addresses,
      docs,
      officeLocations,
      userAllowedLocs,
      departmentManagers,
      pendingLeaveCountRow,
      pendingAttendanceCountRow,
      deptUserCountsRows,
      payrollDetailRow,
    ] = await Promise.all([
      Address.query()
        .where({ user_id: user.id })
        .whereIn('type', ['PRESENT', 'PERMANENT'])
        .select('type', 'street_address', 'city', 'state', 'zip_code', 'country'),
      UserDocument.query()
        .where({ user_id: user.id })
        .whereNotNull('file_key')
        .select(
          'id',
          'doc_category',
          'doc_type',
          'file_url',
          'file_key',
          'verification_status',
          'created_at',
        )
        .where('uploaded_by', viewerUserId)
        .orderBy('created_at', 'desc')
        // Safety cap: this endpoint is UI-facing and should not try to return unbounded documents.
        // Use /api/onboarding/:userId/documents-summary for full/paginated documents.
        .limit(100),
      departmentLocationIds.length > 0
        ? OfficeLocation.query()
            .where('org_id', org_id)
            .whereIn('id', departmentLocationIds)
            .select('id', 'name', 'address', 'latitude', 'longitude', 'radius_meters')
        : [],
      UserAllowedLocation.query()
        .where('org_id', org_id)
        .where('user_id', user.id)
        .select('id', 'label', 'latitude', 'longitude', 'radius_meters')
        .orderBy('created_at', 'asc'),
      managerIds.length > 0
        ? User.query()
            .where('org_id', org_id)
            .whereIn('id', managerIds)
            .whereNull('deleted_at')
            .select(
              'id',
              'employee_id',
              'first_name',
              'last_name',
              'profile_image_url',
              'official_email',
              'role',
              'designation',
            )
        : [],
      includePendingRequests
        ? LeaveRequest.query()
            .where('org_id', org_id)
            .where('user_id', user.id)
            .where('status', 'PENDING')
            .count('* as count')
            .first()
        : Promise.resolve(undefined),
      includePendingRequests
        ? AttendanceCorrectionRequest.query()
            .where('user_id', user.id)
            .where('status', 'PENDING')
            .count('* as count')
            .first()
        : Promise.resolve(undefined),
      associatedDepartmentIds.length > 0
        ? (() => {
            const assoc = knex
              .select(
                knex.raw('u.department_id::uuid as department_id'),
                knex.raw('u.id::uuid as user_id'),
              )
              .from('users as u')
              .where('u.org_id', org_id)
              .whereNull('u.deleted_at')
              .whereIn('u.status', REAL_EMPLOYEE_STATUSES as readonly string[])
              .whereIn('u.role', ['employee', 'hr', 'manager'])
              .whereIn('u.department_id', associatedDepartmentIds)
              .unionAll(
                knex
                  .select(
                    knex.raw('dm.department_id::uuid as department_id'),
                    knex.raw('u.id::uuid as user_id'),
                  )
                  .from('department_managers as dm')
                  .innerJoin('users as u', 'u.id', 'dm.manager_id')
                  .where('u.org_id', org_id)
                  .whereNull('u.deleted_at')
                  .whereIn('u.status', REAL_EMPLOYEE_STATUSES as readonly string[])
                  .whereIn('u.role', ['manager'])
                  .whereIn('dm.department_id', associatedDepartmentIds),
              )
              .as('assoc');

            return knex(assoc)
              .select('department_id')
              .countDistinct({ count: 'user_id' })
              .groupBy('department_id');
          })()
        : Promise.resolve([]),
      UserPayrollDetail.query().findOne({ user_id: user.id }),
    ]);

    const formatDate = (value: Date | string | null | undefined): string | null => {
      if (!value) return null;
      const d = typeof value === 'string' ? new Date(value) : value;
      if (Number.isNaN(d.getTime())) return null;

      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };

    const primaryAddress = (() => {
      const present = addresses.find((a) => a.type === 'PRESENT');
      const permanent = addresses.find((a) => a.type === 'PERMANENT');
      return present ?? permanent ?? null;
    })();

    const formattedAddress = primaryAddress
      ? [
          primaryAddress.street_address,
          primaryAddress.city,
          primaryAddress.state,
          primaryAddress.zip_code,
          primaryAddress.country,
        ]
          .filter(Boolean)
          .join(', ')
      : null;

    const about = {
      user_id: String(user.id),
      full_name: `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim() || null,
      first_name: user.first_name ?? null,
      last_name: user.last_name ?? null,
      role: user.role ?? null,
      official_email: user.official_email ?? null,
      profile_image_url: (user as any).profile_image_url ?? null,
      personal_email: userWithRelations.profile?.personal_email ?? null,
      phone_number: userWithRelations.profile?.personal_phone ?? null,
      date_of_birth: formatDate(userWithRelations.profile?.dob),
      gender: userWithRelations.profile?.gender ?? null,
      marital_status: userWithRelations.profile?.marital_status ?? null,
      blood_group: userWithRelations.profile?.blood_group ?? null,
      nationality: userWithRelations.profile?.nationality ?? null,
      address: formattedAddress,
      addresses: (addresses ?? []).map((a) => ({
        type: a.type,
        street_address: a.street_address ?? null,
        city: a.city ?? null,
        state: a.state ?? null,
        zip_code: a.zip_code ?? null,
        country: a.country ?? null,
      })),
    };

    const managerById = new Map<string, any>();
    for (const m of departmentManagers as any[]) {
      managerById.set(String(m.id), m);
    }

    const reportingManager = (associatedDepartmentsFull as any[]).map((dept) => {
      const deptId = String(dept.id);
      const deptManagerIds = Array.from(
        new Set(
          [
            dept.manager_id ? String(dept.manager_id) : null,
            ...((departmentManagerIdsRows as any[])
              .filter((r) => String(r.department_id) === deptId)
              .map((r) => r.manager_id)
              .filter(Boolean) as string[]),
          ].filter(Boolean) as string[],
        ),
      );

      const managers = deptManagerIds
        .map((id) => managerById.get(String(id)))
        .filter(Boolean)
        .map((m) => ({
          id: String(m.id),
          full_name: `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim() || null,
          employee_id: m.employee_id ?? null,
          official_email: m.official_email ?? null,
          role: m.role ?? null,
          designation: m.designation ?? null,
          profile_image_url: m.profile_image_url ?? null,
        }));

      return {
        department: dept.name ?? null,
        managers,
      };
    });

    const associatedDepartments = associatedDepartmentsFull;
    const deptUserCountMap = new Map<string, number>();
    for (const row of deptUserCountsRows as any[]) {
      const id = row.department_id ? String(row.department_id) : '';
      const count = Number(row.count ?? 0);
      if (id) deptUserCountMap.set(id, Number.isFinite(count) ? count : 0);
    }

    const team = (associatedDepartments as any[]).map((d) => {
      const deptId = String(d.id);
      return {
        department: d.name ?? null,
        count: deptUserCountMap.get(deptId) ?? 0,
      };
    });

    const workLocationArray: Array<{
      id?: string;
      type: 'office' | 'custom';
      name?: string | null;
      address?: string | null;
      latitude?: string | null;
      longitude?: string | null;
      radius_meters?: number | null;
      label?: string | null;
    }> = [];

    for (const loc of officeLocations as any[]) {
      workLocationArray.push({
        id: String(loc.id),
        type: 'office',
        name: loc.name ?? null,
        address: loc.address ?? null,
        latitude: loc.latitude ?? null,
        longitude: loc.longitude ?? null,
        radius_meters: loc.radius_meters ?? null,
      });
    }

    for (const ual of userAllowedLocs as any[]) {
      workLocationArray.push({
        id: String(ual.id),
        type: 'custom',
        label: ual.label ?? null,
        latitude: ual.latitude ?? null,
        longitude: ual.longitude ?? null,
        radius_meters: ual.radius_meters ?? null,
      });
    }

    const departmentArray = (associatedDepartmentsFull as any[]).map((d) => ({
      id: String(d.id),
      name: d.name ?? null,
    }));

    const work = {
      job_details: {
        employee_id: user.employee_id ?? null,
        designation: user.designation ?? null,
        department: departmentArray,
        employment_type: userWithRelations.employmentDetails?.employment_type ?? null,
        work_mode: userWithRelations.employmentDetails?.work_mode ?? null,
        date_of_joining: formatDate(user.date_of_joining as any),
      },
      reporting_manager: reportingManager,
      team,
      ...(includePendingRequests
        ? {
            pending_requests: {
              leaves: Number((pendingLeaveCountRow as any)?.count ?? 0),
              attendance: Number((pendingAttendanceCountRow as any)?.count ?? 0),
            },
          }
        : {}),
      work_location: workLocationArray,
    };

    const payrollDetail = payrollDetailRow as UserPayrollDetail | undefined;

    const documents = {
      total_count: docs.length,
      items: docs.map((d) => ({
        id: String(d.id),
        doc_category: d.doc_category,
        doc_type: d.doc_type,
        file_url: d.file_url,
        file_key: d.file_key ?? null,
        verification_status: (d as any).verification_status ?? 'N/A',
        uploaded_at: formatDate(d.created_at as any),
      })),
    };

    return res.json({
      message: 'Employee overview retrieved successfully',
      data: {
        about,
        work,
        documents,
        payroll: {
          uan_number: payrollDetail?.uan_number ?? null,
          pf_number: payrollDetail?.pf_number ?? null,
        },
      },
    });
  }

  /**
   * Admin / HR entry point to start onboarding for a new employee.
   *
   * This creates User + UserProfile + EmergencyContacts + Addresses + UserOnboarding
   * in a single transaction. Profile data is required to reduce API calls.
   * Additional details (department, job title, payroll, documents, etc.)
   * are filled in via subsequent onboarding APIs.
   */
  static async startOnboarding(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = onboardingStartSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { email, firstName, lastName, profile, employeeType, phone, department_id } = parsed.data;

    const org_id = req.user.org_id;
    let effectiveDepartmentId = department_id;

    if (req.user.role === 'manager') {
      const managedDepartmentIds = await getManagedDepartmentIds(org_id, req.user.id);

      if (effectiveDepartmentId && !managedDepartmentIds.includes(effectiveDepartmentId)) {
        return res.status(403).json({ message: 'Forbidden' });
      }
    }

    if (effectiveDepartmentId) {
      const department = await Department.query().findOne({ id: effectiveDepartmentId, org_id });
      if (!department) {
        return res.status(400).json({ message: 'Invalid department_id' });
      }
    }

    const existingEmail = await User.query()
      .where({ org_id, official_email: email })
      .select('id', 'status')
      .first();
    if (existingEmail) {
      return res.status(409).json({ message: 'Email already exists' });
    }
    // Generate a placeholder password hash so the user row is valid.
    // The real temp password that HR will use for first login is generated
    // only after onboarding is fully completed (in submitCompliance).
    // For admin/hr with an existing cross-org account, reuse that credential.
    const effectiveRoleForPassword = employeeType ?? 'employee';
    const existingCredential = isAdminOrHrRole(effectiveRoleForPassword)
      ? await findExistingAdminHrCredential(email, { excludeOrgId: org_id })
      : null;
    const placeholderPassword = existingCredential ? null : generateTempPassword();
    const password_hash = existingCredential
      ? existingCredential.password_hash
      : await bcrypt.hash(placeholderPassword as string, 10);
    const initialMustChangePassword = existingCredential
      ? existingCredential.must_change_password
      : false;

    const {
      dob,
      gender,
      marital_status,
      nationality,
      personal_email,
      personal_phone,
      alt_phone,
      emergency_contacts,
      addresses,
    } = profile;

    try {
      let created: User;
      let onboardingDataCloned = false;

      await Model.transaction(async (trx) => {
        const effectiveRole = employeeType ?? 'employee';
        await assertOrganizationUserLimit(org_id, effectiveRole, trx);

        // Create user
        created = await User.query(trx).insert({
          org_id,
          // employee_id is intentionally left null during onboarding start.
          // It will be set later via the employment onboarding API once the final code is known.
          first_name: firstName,
          last_name: lastName,
          official_email: email,
          password_hash,
          role: effectiveRole,
          status: 'IN_PROGRESS',
          department_id: effectiveDepartmentId ?? undefined,
          // Will be flipped to true when onboarding completes and the
          // real temp password is generated (unless reused from another org).
          must_change_password: initialMustChangePassword,
        });

        // Initialize onboarding record with IN_PROGRESS status since profile is created
        await UserOnboarding.query(trx).insert({
          user_id: created.id,
          onboarding_status: 'IN_PROGRESS',
        });

        // Create profile in the same transaction
        await UserProfile.query(trx).insert({
          user_id: created.id,
          dob,
          gender,
          marital_status,
          nationality,
          personal_email,
          personal_phone:
            normalizeIndianPhone10Digits(personal_phone) ??
            normalizeIndianPhone10Digits(phone) ??
            undefined,
          alt_phone,
        });

        // Create emergency contacts
        if (emergency_contacts.length > 0) {
          await EmergencyContact.query(trx).insert(
            emergency_contacts.map((contact) => ({
              user_id: created.id,
              name: contact.name,
              relation: contact.relation,
              phone: contact.phone,
              email: contact.email,
              is_primary: contact.is_primary ?? false,
            })),
          );
        }

        // Create addresses
        if (addresses.length > 0) {
          await Address.query(trx).insert(
            addresses.map((address) => ({
              user_id: created.id,
              type: address.type,
              street_address: address.street_address,
              city: address.city,
              state: address.state,
              zip_code: address.zip_code,
              country: address.country,
            })),
          );
        }

        // Prefer sibling admin/hr person data (docs, bank, identities) when password reused.
        if (existingCredential) {
          try {
            onboardingDataCloned = await cloneAdminHrPersonDataFromEmail({
              email,
              targetUserId: created.id,
              targetOrgId: org_id,
              trx,
              targetRole: isAdminOrHrRole(created.role)
                ? (created.role as 'admin' | 'hr')
                : undefined,
            });
          } catch (err) {
            if (!(err instanceof AdminHrCrossOrgEligibilityError)) {
              throw err;
            }
            logger.warn(
              { err, user_id: created.id, org_id },
              'Skipped admin/hr onboarding clone due to eligibility gate',
            );
          }
        }
      });

      const createdUser = created!;

      return res.status(201).json({
        id: createdUser.id,
        org_id: createdUser.org_id,
        // employee_id is intentionally omitted here; it should be set later via the
        // employment onboarding API once the final employee code is known.
        first_name: createdUser.first_name,
        last_name: createdUser.last_name,
        official_email: createdUser.official_email,
        role: createdUser.role,
        status: createdUser.status,
        department_id: createdUser.department_id,
        onboarding_status: 'IN_PROGRESS',
        password_reused: Boolean(existingCredential),
        onboarding_data_cloned: onboardingDataCloned,
      });
    } catch (error) {
      if (error instanceof OrganizationUserLimitExceededError) {
        return res.status(403).json({ message: error.message });
      }
      if (error instanceof ForeignKeyViolationError) {
        return res.status(400).json({ message: 'Invalid departmentId' });
      }
      if (
        error instanceof UniqueViolationError &&
        error.constraint === 'user_profiles_personal_email_unique'
      ) {
        return res.status(409).json({ message: 'personal_email already exists' });
      }
      throw error;
    }
  }
  static async updateFinancials(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = onboardingFinanceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { payroll_info, earnings, earnings_items, deductions, deductions_items, net_payable } =
      parsed.data;

    const user_id = await OnboardingController.resolveTargetUserId(req, res);
    if (!user_id) {
      return res as Response;
    }

    try {
      await Model.transaction(async (trx) => {
        const org_id = req.user!.org_id;

        const money = OnboardingController.sanitizeMoney;
        // All values in the payload are ANNUAL except salary_per_month which is monthly
        // Convert annual values to monthly by dividing by 12
        const annual_ctc = money(payroll_info.annual_ctc);
        const annual_basic_salary = money(earnings.basic_salary);
        const annual_hra = money(earnings.hra);
        const annual_other_allowance = money((earnings as any).other_allowance ?? 0);
        const annual_gross_earnings = money(
          earnings.gross_earnings ?? annual_basic_salary + annual_hra + annual_other_allowance,
        );
        const annual_pf = money(deductions?.pf ?? 0);
        const annual_professional_tax = money(deductions?.professional_tax ?? 0);
        const annual_total_deductions = money(
          deductions?.total_deductions ?? annual_pf + annual_professional_tax,
        );

        // Convert annual values to monthly (divide by 12)
        const basic_salary = money(annual_basic_salary / 12);
        const hra = money(annual_hra / 12);
        const other_allowance = money(annual_other_allowance / 12);
        const gross_earnings = money(annual_gross_earnings / 12);
        const pf = money(annual_pf / 12);
        const professional_tax = money(annual_professional_tax / 12);
        const _total_deductions = money(annual_total_deductions / 12);

        // salary_per_month is already monthly, so use as-is or calculate from monthly values
        const salary_per_month = money(
          net_payable?.salary_per_month ?? gross_earnings - _total_deductions,
        );

        const ensureComponent = async (input: {
          code: string;
          name: string;
          type: SalaryComponent['type'];
          display_order: number;
          is_taxable?: boolean;
          is_pf_applicable?: boolean;
          is_esi_applicable?: boolean;
        }): Promise<SalaryComponent> => {
          const existing = await SalaryComponent.query(trx)
            .where({ org_id, code: input.code })
            .whereNull('deleted_at')
            .first();
          if (existing) return existing;

          try {
            return await SalaryComponent.query(trx).insert({
              org_id,
              code: input.code,
              name: input.name,
              type: input.type,
              display_order: input.display_order,
              is_taxable: input.is_taxable ?? true,
              is_pf_applicable: input.is_pf_applicable ?? false,
              is_esi_applicable: input.is_esi_applicable ?? false,
            });
          } catch (err) {
            if (err instanceof UniqueViolationError) {
              const reloaded = await SalaryComponent.query(trx)
                .where({ org_id, code: input.code })
                .whereNull('deleted_at')
                .first();
              if (reloaded) return reloaded;
            }
            throw err;
          }
        };

        const [basicComp, hraComp, otherAllowComp, pfComp, profTaxComp] = await Promise.all([
          ensureComponent({
            code: 'BASIC',
            name: 'Basic Salary',
            type: 'EARNING',
            display_order: 10,
          }),
          ensureComponent({
            code: 'HRA',
            name: 'House Rent Allowance',
            type: 'ALLOWANCE',
            display_order: 20,
          }),
          ensureComponent({
            code: 'OTHER_ALLOWANCE',
            name: 'Other Allowance',
            type: 'ALLOWANCE',
            display_order: 30,
          }),
          ensureComponent({
            code: 'PF',
            name: 'Provident Fund (PF)',
            type: 'DEDUCTION',
            display_order: 110,
            is_taxable: false,
            is_pf_applicable: true,
          }),
          ensureComponent({
            code: 'PROFESSIONAL_TAX',
            name: 'Professional Tax',
            type: 'DEDUCTION',
            display_order: 120,
            is_taxable: false,
          }),
        ]);

        const component_breakdown: Record<string, number> = {
          [basicComp.id]: basic_salary,
          [hraComp.id]: hra,
          [otherAllowComp.id]: other_allowance,
          [pfComp.id]: pf,
          [profTaxComp.id]: professional_tax,
        };

        const dynamicEarnings = normalizeFinanceItems(earnings_items);
        const dynamicDeductions = normalizeFinanceItems(deductions_items);

        let nextDisplayOrder = 200;
        for (const item of dynamicEarnings) {
          const comp = await ensureFinanceItemComponent({
            trx,
            org_id,
            kind: 'EARNING',
            name: item.name,
            display_order: nextDisplayOrder++,
            queryByCode: async (t, o, code) => {
              return (await SalaryComponent.query(t)
                .where({ org_id: o, code })
                .whereNull('deleted_at')
                .first()) as any;
            },
            insertComponent: async (t, input) => {
              try {
                return (await SalaryComponent.query(t).insert({
                  ...input,
                  is_taxable: true,
                  is_pf_applicable: false,
                  is_esi_applicable: false,
                  is_active: true,
                })) as any;
              } catch (err) {
                if (err instanceof UniqueViolationError) {
                  const reloaded = await SalaryComponent.query(t)
                    .where({ org_id: input.org_id, code: input.code })
                    .whereNull('deleted_at')
                    .first();
                  if (reloaded) return reloaded as any;
                }
                throw err;
              }
            },
          });

          component_breakdown[String((comp as any).id)] = money(Number(item.amount) / 12);
        }

        for (const item of dynamicDeductions) {
          const comp = await ensureFinanceItemComponent({
            trx,
            org_id,
            kind: 'DEDUCTION',
            name: item.name,
            display_order: nextDisplayOrder++,
            queryByCode: async (t, o, code) => {
              return (await SalaryComponent.query(t)
                .where({ org_id: o, code })
                .whereNull('deleted_at')
                .first()) as any;
            },
            insertComponent: async (t, input) => {
              try {
                return (await SalaryComponent.query(t).insert({
                  ...input,
                  is_taxable: false,
                  is_pf_applicable: false,
                  is_esi_applicable: false,
                  is_active: true,
                })) as any;
              } catch (err) {
                if (err instanceof UniqueViolationError) {
                  const reloaded = await SalaryComponent.query(t)
                    .where({ org_id: input.org_id, code: input.code })
                    .whereNull('deleted_at')
                    .first();
                  if (reloaded) return reloaded as any;
                }
                throw err;
              }
            },
          });

          component_breakdown[String((comp as any).id)] = money(Number(item.amount) / 12);
        }

        await SalaryStructure.query(trx)
          .where({ user_id, is_active: true })
          .whereNull('deleted_at')
          .patch({ is_active: false });

        await SalaryStructure.query(trx).insert({
          org_id,
          user_id,
          effective_from: new Date(),
          gross_salary: gross_earnings,
          net_salary: salary_per_month,
          employer_total_contributions: Number(
            parsed.data?.employer_contributions?.total_contributions ?? 0,
          ),
          component_breakdown,
          notes: 'onboarding_finance_v2',
          is_active: true,
        });

        await EmployeeEmploymentDetail.query(trx)
          .insert({
            user_id,
            base_salary: basic_salary,
            annual_ctc,
          })
          .onConflict('user_id')
          .merge({
            base_salary: basic_salary,
            annual_ctc,
          });
      });
    } catch {
      return res.status(500).json({ message: 'Failed to update financial details' });
    }

    if (req.user.org_id) {
      generateCurrentMonthPayrollForUser(user_id, req.user.org_id).catch((err) => {
        logger.error(
          { err, user_id, org_id: req.user.org_id },
          'Failed to generate current month payroll after financial details update (unconditional)',
        );
      });
    }

    // If onboarding is already completed (common in reverse flow where compliance
    // is submitted before finance), generate current month payroll now that
    // salary structure exists. Idempotent, so safe on repeated finance updates.
    if (req.user.org_id) {
      const onboarding = await UserOnboarding.query().findOne({ user_id });
      if (onboarding?.onboarding_status === 'COMPLETED') {
        generateCurrentMonthPayrollForUser(user_id, req.user.org_id).catch((err) => {
          logger.error(
            { err, user_id, org_id: req.user.org_id },
            'Failed to generate current month payroll after financial details update',
          );
        });
      }

      syncAdminHrOnboardingComplianceForUserIfApplicable({
        userId: user_id,
        orgId: req.user.org_id,
      }).catch((err) => {
        logger.error(
          { err, user_id, org_id: req.user.org_id },
          'Failed to sync admin/hr finance fields across orgs',
        );
      });
    }

    return res.json({ message: 'Financial details updated successfully' });
  }

  /**
   * Admin / HR: update employment & compensation details for an employee
   * during onboarding (Step 2 in the UI).
   */
  static async updateEmployment(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = onboardingEmploymentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const {
      employeeId,
      department_id,
      designation,
      date_of_joining,
      employment_type,
      work_mode,
      shift_mode,
    } = parsed.data;

    const user_id = await OnboardingController.resolveTargetUserId(req, res);
    if (!user_id) {
      return res as Response;
    }

    const org_id = req.user.org_id;

    if (department_id) {
      const department = await Department.query().findOne({ id: department_id, org_id });
      if (!department) {
        return res.status(400).json({ message: 'Invalid department_id' });
      }
    }

    if (employeeId) {
      const existingEmpId = await User.query()
        .select('id', 'first_name', 'last_name', 'employee_id', 'official_email')
        .where({ org_id, employee_id: employeeId })
        .whereNot('id', user_id)
        .whereNull('deleted_at')
        .first();
      if (existingEmpId) {
        const existingUserName =
          `${existingEmpId.first_name ?? ''} ${existingEmpId.last_name ?? ''}`.trim() || null;
        return res.status(409).json({
          message: 'employeeId already exists',
          employee_id: employeeId,
          existing_user: {
            id: existingEmpId.id,
            name: existingUserName,
            first_name: existingEmpId.first_name ?? null,
            last_name: existingEmpId.last_name ?? null,
            official_email: existingEmpId.official_email ?? null,
          },
        });
      }
    }

    try {
      await Model.transaction(async (trx) => {
        if (department_id || designation || date_of_joining || employeeId) {
          const numUpdated = await User.query(trx)
            .patch({
              employee_id: employeeId ?? undefined,
              department_id: department_id ?? undefined,
              designation: designation ?? undefined,
              date_of_joining: date_of_joining ?? undefined,
            })
            .where({ id: user_id, org_id });

          if (numUpdated === 0) {
            // We can throw an error here to trigger transaction rollback,
            // but we can't easily return 404 from inside transaction without throwing.
            // However, if we throw a custom error, we can catch it.
            // Or just let it finish and return 404 outside?
            // No, we are inside transaction.
            // Throwing an Error is safest to ensure rollback if we had other partial updates (none here yet).
            throw new Error('User not found or access denied');
          }
        }

        if (employment_type !== undefined || work_mode !== undefined || shift_mode !== undefined) {
          await EmployeeEmploymentDetail.query(trx)
            .insert({
              user_id,
              employment_type,
              work_mode,
              // Store shift mode in notes for now (e.g. "day" / "night")
              notes: shift_mode ?? undefined,
            })
            .onConflict('user_id')
            .merge({
              employment_type,
              work_mode,
              notes: shift_mode ?? undefined,
            });
        }
      });
    } catch (err: any) {
      if (err.message === 'User not found or access denied') {
        return res.status(404).json({ message: 'User not found or access denied' });
      }
      throw err;
    }

    if (req.user?.org_id) {
      syncAdminHrOnboardingComplianceForUserIfApplicable({
        userId: user_id,
        orgId: req.user.org_id,
      }).catch((err) => {
        logger.error(
          { err, user_id, org_id: req.user.org_id },
          'Failed to sync admin/hr employment fields across orgs',
        );
      });
    }

    return res.json({ message: 'Employment details updated successfully' });
  }

  static async uploadDocument(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const user_id = await OnboardingController.resolveTargetUserId(req, res);
    if (!user_id) {
      return res as Response;
    }

    const org_id = req.user.org_id;

    // Check if files are present (new merged API with file upload)
    const files = (req.files as Express.Multer.File[]) || [];

    const kycFlowEnabled = await OnboardingController.isKycFlowEnabledForOrg(org_id);

    if (files.length > 0) {
      // New merged flow: files + metadata in one request.
      // Also supports "named" fields like aadhar_front/pan_card/etc (same as /employee/documents)
      // where doc_category/doc_type may be inferred from the fieldname.
      const { doc_category, doc_type, doc_types } = req.body as Record<string, unknown>;

      const CATEGORY_MAP: Record<string, string> = {
        aadhar_front: 'IDENTITY',
        aadhar_back: 'IDENTITY',
        pan_card: 'IDENTITY',
        passport_size_photo: 'IDENTITY',
        passport_doc: 'IDENTITY',
        marksheet_10th: 'EDUCATION',
        marksheet_12th: 'EDUCATION',
        degree_certificate: 'EDUCATION',
        previous_offer_letters: 'EXPERIENCE',
        experience_letter: 'EXPERIENCE',
        salary_slip_month_1: 'EXPERIENCE',
        salary_slip_month_2: 'EXPERIENCE',
      };

      const validCategories = ['IDENTITY', 'EDUCATION', 'EXPERIENCE', 'FINANCE', 'LEGAL'] as const;

      const usingExplicitMetadata =
        typeof doc_category === 'string' &&
        validCategories.includes(doc_category as (typeof validCategories)[number]) &&
        (typeof doc_type === 'string' || typeof doc_types === 'string' || Array.isArray(doc_types));

      // Explicit-metadata mode (backward compatible with older clients posting "files")
      let docTypesArray: string[] = [];
      let docCategoryForAll: string | undefined;
      if (usingExplicitMetadata) {
        docCategoryForAll = doc_category as string;

        if (doc_types) {
          try {
            // Handle both JSON array string and actual array
            docTypesArray = Array.isArray(doc_types)
              ? (doc_types as string[])
              : JSON.parse(doc_types as string);
            if (!Array.isArray(docTypesArray) || docTypesArray.length !== files.length) {
              return res.status(400).json({
                message: `doc_types array must have ${files.length} elements (one per file)`,
              });
            }
          } catch {
            return res.status(400).json({
              message: 'doc_types must be a valid array matching the number of files',
            });
          }
        } else if (doc_type) {
          // Use single doc_type for all files
          if (typeof doc_type !== 'string' || doc_type.trim().length === 0) {
            return res
              .status(400)
              .json({ message: 'doc_type is required and must be a non-empty string' });
          }
          docTypesArray = Array(files.length).fill(doc_type.trim());
        } else {
          return res.status(400).json({
            message:
              'Either doc_type (for all files) or doc_types array (one per file) is required',
          });
        }
      } else {
        // Inferred mode (named fields like aadhar_front, pan_card, passport_size_photo, etc)
        // If the field is "files", we cannot infer doc_type/category.
        const hasGenericFilesField = files.some(
          (f) => f.fieldname === 'files' || f.fieldname === 'file',
        );
        if (hasGenericFilesField) {
          return res.status(400).json({
            message:
              'When uploading using field "files", doc_category and doc_type(s) are required. ' +
              'Alternatively upload using named fields like aadhar_front, aadhar_back, pan_card, passport_size_photo.',
          });
        }
      }

      const sanitizeFilename = (name: string): string =>
        name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');

      const client = getS3Client();

      try {
        // Upload all files to S3 and prepare document data
        const uploadPromises = files.map(async (file, index) => {
          const inferredCategory = CATEGORY_MAP[file.fieldname] || 'IDENTITY';
          const effectiveCategory = docCategoryForAll ?? inferredCategory;
          const effectiveDocType = docCategoryForAll
            ? docTypesArray[index]?.trim()
            : file.fieldname.toUpperCase();

          if (!effectiveDocType || effectiveDocType.length === 0) {
            throw new Error(`doc_type is required for file ${index + 1}`);
          }

          if (!validCategories.includes(effectiveCategory as any)) {
            throw new Error(`Invalid doc_category: ${effectiveCategory}`);
          }

          const safeName = sanitizeFilename(file.originalname);
          const key = [
            'orgs',
            org_id,
            'users',
            user_id,
            'documents',
            effectiveCategory,
            effectiveDocType,
            `${crypto.randomUUID()}-${safeName}`,
          ].join('/');

          // Upload file to S3
          await client.send(
            new PutObjectCommand({
              Bucket: env.S3_BUCKET,
              Key: key,
              Body: file.buffer,
              ContentType: file.mimetype,
            }),
          );

          const file_url = buildS3PublicUrl(key);

          return {
            user_id,
            doc_category: effectiveCategory,
            doc_type: effectiveDocType,
            file_url,
            file_key: key,
          };
        });

        const documentData = await Promise.all(uploadPromises);

        const existingIdentityDocs = await UserDocument.query()
          .where({ user_id })
          .whereIn('doc_type', ['AADHAR_FRONT', 'AADHAR_BACK', 'PAN_CARD']);
        const uploadedDocTypeSet = new Set(documentData.map((d) => String((d as any).doc_type)));
        const existingDocTypeSet = new Set(
          existingIdentityDocs.map((d) => String((d as any).doc_type)),
        );
        const allDocTypes = new Set<string>([...uploadedDocTypeSet, ...existingDocTypeSet]);
        const missingRequiredIdentityDocs = ['AADHAR_FRONT', 'AADHAR_BACK', 'PAN_CARD'].filter(
          (t) => !allDocTypes.has(t),
        );

        const isSelfUpload = req.user?.id === user_id;
        if (kycFlowEnabled && isSelfUpload && missingRequiredIdentityDocs.length > 0) {
          return res.status(400).json({
            message:
              'When KYC flow is enabled, Aadhaar front/back and PAN card documents are required before completing identity documents upload.',
            missing_doc_types: missingRequiredIdentityDocs,
          });
        }

        // Save all documents to database
        const created = await UserDocument.query().insert(
          documentData.map((doc) => ({
            ...doc,
            uploaded_by: req.user!.id,
          })),
        );
        const createdDocs = Array.isArray(created) ? created : [created];

        // Automatically index passport photo into Rekognition (if available)
        const passportPhoto = createdDocs.find(
          (doc) => doc.doc_type === 'PASSPORT_SIZE_PHOTO' && doc.file_key,
        );
        if (passportPhoto && env.S3_BUCKET) {
          try {
            await indexUserFaceFromS3(
              org_id,
              user_id,
              env.S3_BUCKET,
              passportPhoto.file_key as string,
              { rethrow: true },
            );
          } catch (err: unknown) {
            const uploadedKeys = documentData
              .map((d: any) => String(d?.file_key ?? ''))
              .filter((k: string) => k.length > 0);
            const createdIds = createdDocs.map((d: any) => d.id).filter(Boolean);

            if (createdIds.length > 0) {
              await UserDocument.query()
                .delete()
                .whereIn('id', createdIds as any);
            }

            await cleanupUploadedS3Keys(uploadedKeys);

            const { status, message } = getPassportPhotoFaceIndexErrorResponse(err);
            return res.status(status).json({ message });
          }
        }

        syncAdminHrOnboardingComplianceForUserIfApplicable({
          userId: user_id,
          orgId: org_id,
        }).catch((err) => {
          logger.error({ err, user_id, org_id }, 'Failed to sync admin/hr documents across orgs');
        });

        return res.status(201).json({
          documents: createdDocs.map((doc) => ({
            id: doc.id,
            doc_category: doc.doc_category,
            doc_type: doc.doc_type,
            file_url: doc.file_url,
            file_key: doc.file_key,
            verification_status: doc.verification_status,
          })),
          count: createdDocs.length,
        });
      } catch (error) {
        return res.status(500).json({
          message:
            error instanceof Error ? error.message : 'Failed to upload files and save documents',
        });
      }
    }

    // Backward compatibility: Check if this is a bulk upload (has 'documents' array)
    const bulkParsed = onboardingDocumentsSchema.safeParse(req.body);
    if (bulkParsed.success) {
      // Bulk upload: multiple documents (metadata only, files already uploaded)
      const { documents } = bulkParsed.data;

      const created = await UserDocument.query().insert(
        documents.map((doc) => ({
          user_id,
          doc_category: doc.doc_category,
          doc_type: doc.doc_type,
          file_url: doc.file_url,
          file_key: doc.file_key,
          uploaded_by: req.user!.id,
        })),
      );
      const createdDocs = Array.isArray(created) ? created : [created];

      const passportPhoto = createdDocs.find(
        (doc) => doc.doc_type === 'PASSPORT_SIZE_PHOTO' && doc.file_key,
      );
      if (passportPhoto && org_id && env.S3_BUCKET) {
        try {
          await indexUserFaceFromS3(
            org_id,
            user_id,
            env.S3_BUCKET,
            passportPhoto.file_key as string,
            {
              rethrow: true,
            },
          );
        } catch (err: unknown) {
          const createdIds = createdDocs.map((d: any) => d.id).filter(Boolean);
          if (createdIds.length > 0) {
            await UserDocument.query()
              .delete()
              .whereIn('id', createdIds as any);
          }

          const uploadedKeys = createdDocs
            .map((d) => String(d.file_key ?? ''))
            .filter((k) => k.length > 0);
          await cleanupUploadedS3Keys(uploadedKeys);

          const { status, message } = getPassportPhotoFaceIndexErrorResponse(err);
          return res.status(status).json({ message });
        }
      }

      return res.status(201).json({
        documents: createdDocs.map((doc) => ({
          id: doc.id,
          doc_category: doc.doc_category,
          doc_type: doc.doc_type,
          file_url: doc.file_url,
          verification_status: doc.verification_status,
        })),
        count: createdDocs.length,
      });
    }

    // Backward compatibility: Single document upload (metadata only)
    const parsed = onboardingDocumentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message:
          'Invalid request body. Either provide files with doc_category/doc_type, or provide document metadata (file_url, doc_category, doc_type)',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { doc_category, doc_type, file_url, file_key } = parsed.data;

    const created = await UserDocument.query().insert({
      user_id,
      doc_category,
      doc_type,
      file_url,
      file_key,
      uploaded_by: req.user!.id,
    });

    return res.status(201).json({
      id: created.id,
      doc_category: created.doc_category,
      doc_type: created.doc_type,
      file_url: created.file_url,
      verification_status: created.verification_status,
    });
  }

  static async replaceUserDocument(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const user_id = await OnboardingController.resolveTargetUserId(req, res);
    if (!user_id) {
      return res as Response;
    }

    const org_id = req.user.org_id;
    const file = (req as any).file as Express.Multer.File | undefined;
    const doc_type_raw =
      typeof (req.body as any)?.doc_type === 'string' ? (req.body as any).doc_type : '';
    const doc_type = doc_type_raw.trim().toUpperCase();
    const doc_category_raw =
      typeof (req.body as any)?.doc_category === 'string'
        ? (req.body as any).doc_category
        : undefined;
    const doc_category = doc_category_raw?.trim();

    if (!file) {
      return res.status(400).json({ message: '`file` is required' });
    }
    if (!doc_type) {
      return res.status(400).json({ message: '`doc_type` is required' });
    }

    const validCategories = ['IDENTITY', 'EDUCATION', 'EXPERIENCE', 'FINANCE', 'LEGAL'] as const;
    if (
      doc_category !== undefined &&
      doc_category.length > 0 &&
      !validCategories.includes(doc_category as any)
    ) {
      return res.status(400).json({
        message: 'Invalid doc_category. Must be one of: ' + validCategories.join(', '),
      });
    }

    const existing = await UserDocument.query()
      .where({ user_id, doc_type })
      .modify((qb) => {
        if (doc_category && doc_category.length > 0) {
          qb.andWhere('doc_category', doc_category);
        }
      })
      .first();

    if (!existing) {
      return res.status(404).json({ message: 'Document not found for the given doc_type' });
    }

    if (!env.S3_BUCKET) {
      return res.status(500).json({ message: 'S3 is not configured' });
    }

    const sanitizeFilename = (name: string): string =>
      name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
    const safeName = sanitizeFilename(file.originalname);
    const effectiveCategory =
      doc_category && doc_category.length > 0
        ? doc_category
        : String((existing as any).doc_category);

    const key = [
      'orgs',
      org_id,
      'users',
      user_id,
      'documents',
      effectiveCategory,
      doc_type,
      `${crypto.randomUUID()}-${safeName}`,
    ].join('/');

    const client = getS3Client();

    try {
      await client.send(
        new PutObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype,
        }),
      );
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to upload file',
      });
    }

    const file_url = buildS3PublicUrl(key);

    try {
      const updated = await UserDocument.query().patchAndFetchById(existing.id, {
        file_url,
        file_key: key,
      });

      if (doc_type === 'PASSPORT_SIZE_PHOTO' && env.S3_BUCKET) {
        try {
          await indexUserFaceFromS3(org_id, user_id, env.S3_BUCKET, key, { rethrow: true });
        } catch (err: unknown) {
          await UserDocument.query().patchAndFetchById(existing.id, {
            file_url: (existing as any).file_url,
            file_key: (existing as any).file_key ?? null,
          });

          await cleanupUploadedS3Keys([key]);

          const { status, message } = getPassportPhotoFaceIndexErrorResponse(err);
          return res.status(status).json({ message });
        }
      }

      return res.status(200).json({
        id: updated.id,
        user_id: updated.user_id,
        doc_category: updated.doc_category,
        doc_type: updated.doc_type,
        file_url: updated.file_url,
        file_key: updated.file_key,
        verification_status: updated.verification_status,
        uploaded_by: updated.uploaded_by ?? null,
      });
    } catch (error) {
      // Best-effort cleanup: remove the newly uploaded object if DB patch fails
      try {
        await client.send(
          new DeleteObjectCommand({
            Bucket: env.S3_BUCKET,
            Key: key,
          }),
        );
      } catch {
        // best-effort cleanup only
      }

      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to replace document',
      });
    }
  }

  /**
   * Admin / HR / Manager: upload a new document on behalf of an employee.
   * Upserts by doc_type and sets uploaded_by to the target user (not the caller).
   */
  static async uploadNewDocumentForUser(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const user_id = await OnboardingController.resolveTargetUserId(req, res);
    if (!user_id) {
      return res as Response;
    }

    const org_id = req.user.org_id;
    const file = (req as any).file as Express.Multer.File | undefined;
    const doc_type_raw =
      typeof (req.body as any)?.doc_type === 'string' ? (req.body as any).doc_type : '';
    const doc_type = doc_type_raw.trim().toUpperCase();
    const doc_category_raw =
      typeof (req.body as any)?.doc_category === 'string' ? (req.body as any).doc_category : '';
    const doc_category = doc_category_raw.trim();

    if (!file) {
      return res.status(400).json({ message: '`file` is required' });
    }
    if (!doc_type) {
      return res.status(400).json({ message: '`doc_type` is required' });
    }
    if (!doc_category) {
      return res.status(400).json({ message: '`doc_category` is required' });
    }

    const validCategories = ['IDENTITY', 'EDUCATION', 'EXPERIENCE', 'FINANCE', 'LEGAL'] as const;
    if (!validCategories.includes(doc_category as any)) {
      return res.status(400).json({
        message: 'Invalid doc_category. Must be one of: ' + validCategories.join(', '),
      });
    }

    if (!env.S3_BUCKET) {
      return res.status(500).json({ message: 'S3 is not configured' });
    }

    const sanitizeFilename = (name: string): string =>
      name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
    const safeName = sanitizeFilename(file.originalname);

    const key = [
      'orgs',
      org_id,
      'users',
      user_id,
      'documents',
      doc_category,
      doc_type,
      `${crypto.randomUUID()}-${safeName}`,
    ].join('/');

    const client = getS3Client();

    try {
      await client.send(
        new PutObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype,
        }),
      );
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to upload file',
      });
    }

    const file_url = buildS3PublicUrl(key);

    try {
      const created = await UserDocument.transaction(async (trx) => {
        await UserDocument.query(trx)
          .delete()
          .where('user_id', user_id)
          .where('doc_type', doc_type);

        return UserDocument.query(trx).insert({
          user_id,
          doc_category,
          doc_type,
          file_url,
          file_key: key,
          verification_status: 'PENDING',
          uploaded_by: user_id,
        });
      });

      if (doc_type === 'PASSPORT_SIZE_PHOTO' && env.S3_BUCKET) {
        try {
          await indexUserFaceFromS3(org_id, user_id, env.S3_BUCKET, key, { rethrow: true });
        } catch (err: unknown) {
          await UserDocument.query().delete().where('id', created.id);
          await cleanupUploadedS3Keys([key]);

          const { status, message } = getPassportPhotoFaceIndexErrorResponse(err);
          return res.status(status).json({ message });
        }
      }

      return res.status(201).json({
        id: created.id,
        user_id: created.user_id,
        doc_category: created.doc_category,
        doc_type: created.doc_type,
        file_url: created.file_url,
        file_key: created.file_key,
        verification_status: created.verification_status,
        uploaded_by: created.uploaded_by ?? null,
      });
    } catch (error) {
      try {
        await client.send(
          new DeleteObjectCommand({
            Bucket: env.S3_BUCKET,
            Key: key,
          }),
        );
      } catch {
        // best-effort cleanup only
      }

      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to save document',
      });
    }
  }

  /**
   * Final onboarding step: compliance + benefits + status + welcome email.
   * This endpoint:
   * - Updates compliance & signed offer letter
   * - Optionally updates benefits/allowances and active status
   * - When onboarding first becomes COMPLETED, generates a temp password
   */
  static async submitCompliance(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const complianceParsed = onboardingComplianceSchema.safeParse(req.body);
    if (!complianceParsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: complianceParsed.error.flatten().fieldErrors,
      });
    }

    const benefitsParsed = onboardingBenefitsSchema.safeParse(req.body);
    if (!benefitsParsed.success && benefitsParsed.error) {
      // We treat benefits errors the same way; merge both error sets if needed.
      return res.status(400).json({
        message: 'Invalid request body',
        errors: benefitsParsed.error.flatten().fieldErrors,
      });
    }

    const {
      device_pref,
      asset_agreement,
      policy_acknowledged,
      offer_letter_url,
      documents,
      document_list,
    } = complianceParsed.data as {
      device_pref?: string;
      asset_agreement?: boolean;
      policy_acknowledged?: boolean;
      offer_letter_url?: string;
      documents?: {
        offer_letter_url?: string;
        cv_url?: string;
        id_url?: string;
        contract_agreement_url?: string;
      };
      document_list?: Array<{
        doc_category: string;
        doc_type: string;
        file_url: string;
        file_key?: string;
      }>;
    };
    const benefitsPayload = benefitsParsed.success ? benefitsParsed.data : {};

    const user_id = await OnboardingController.resolveTargetUserId(req, res);
    if (!user_id) {
      return res as Response;
    }
    const existing = await UserOnboarding.query().findOne({ user_id });
    const effectiveOfferLetterUrl = documents?.offer_letter_url ?? offer_letter_url;
    const offer_letter_signed = effectiveOfferLetterUrl
      ? true
      : (existing?.offer_letter_signed ?? false);
    const stored_offer_letter_url = effectiveOfferLetterUrl ?? existing?.offer_letter_url;

    // Use existing values if incoming values are undefined (for optional fields)
    const effectiveAssetAgreement = asset_agreement ?? existing?.asset_agreement_accepted ?? false;
    const effectivePolicyAcknowledged =
      policy_acknowledged ?? existing?.policy_acknowledged ?? false;

    const hasAdminDocumentsComplete = await OnboardingController.hasAdminStepDocumentsComplete(
      req.user.org_id,
      user_id,
    );
    const isKycVerified = String(existing?.kyc_status ?? '').toUpperCase() === 'VERIFIED';
    const kycFlowEnabled = await OnboardingController.isKycFlowEnabledForOrg(req.user.org_id);

    const onboarding_status = resolveOnboardingStatusFromComplianceAndKyc({
      offerLetterSigned: Boolean(offer_letter_signed),
      kycStatus: existing?.kyc_status,
      hasAdminDocumentsComplete,
      kycFlowEnabled,
    });
    const completed_at = onboarding_status === 'COMPLETED' ? new Date().toISOString() : null;
    const wasCompletedBefore = existing?.onboarding_status === 'COMPLETED';
    const justCompletedNow = onboarding_status === 'COMPLETED' && !wasCompletedBefore;
    const sendWelcomeEmailRequested = Boolean((benefitsPayload as any)?.send_welcome_email);
    // Block welcome email only when KYC is already VERIFIED.
    // Admin step documents completion should not prevent the initial welcome email,
    // it should only prevent re-sends (handled by must_change_password guard).
    const isEmailBlocked = isKycVerified;

    let tempPassword: string | undefined;

    await Model.transaction(async (trx) => {
      // Build update object - only include fields that are provided (not undefined)
      const updateData: any = {
        offer_letter_signed,
        offer_letter_url: stored_offer_letter_url,
        onboarding_status,
        completed_at,
      };

      if (device_pref !== undefined) {
        updateData.asset_device_pref = device_pref;
      }
      if (asset_agreement !== undefined) {
        updateData.asset_agreement_accepted = asset_agreement;
      }
      if (policy_acknowledged !== undefined) {
        updateData.policy_acknowledged = policy_acknowledged;
      }

      const onboardingInsert = {
        user_id,
        asset_device_pref: device_pref ?? existing?.asset_device_pref ?? null,
        asset_agreement_accepted: effectiveAssetAgreement,
        policy_acknowledged: effectivePolicyAcknowledged,
        offer_letter_signed,
        offer_letter_url: stored_offer_letter_url,
        onboarding_status,
        completed_at,
      };
      await UserOnboarding.query(trx)
        .insert(onboardingInsert as Partial<UserOnboarding>)
        .onConflict('user_id')
        .merge(updateData);

      if (effectiveOfferLetterUrl) {
        const existingDoc = await UserDocument.query(trx).findOne({
          user_id,
          doc_type: 'OFFER_LETTER',
        });

        if (existingDoc) {
          await UserDocument.query(trx)
            .patch({ file_url: effectiveOfferLetterUrl })
            .where({ id: existingDoc.id });
        } else {
          await UserDocument.query(trx).insert({
            user_id,
            doc_category: 'LEGAL',
            doc_type: 'OFFER_LETTER',
            file_url: effectiveOfferLetterUrl,
          });
        }
      }

      // Additional onboarding-related documents provided via documents object
      if (documents?.cv_url) {
        const existingCv = await UserDocument.query(trx).findOne({
          user_id,
          doc_type: 'CV',
        });

        if (existingCv) {
          await UserDocument.query(trx)
            .patch({ file_url: documents.cv_url })
            .where({ id: existingCv.id });
        } else {
          await UserDocument.query(trx).insert({
            user_id,
            doc_category: 'EXPERIENCE',
            doc_type: 'CV',
            file_url: documents.cv_url,
          });
        }
      }

      if (documents?.id_url) {
        const existingId = await UserDocument.query(trx).findOne({
          user_id,
          doc_type: 'IDENTITY_PROOF',
        });

        if (existingId) {
          await UserDocument.query(trx)
            .patch({ file_url: documents.id_url })
            .where({ id: existingId.id });
        } else {
          await UserDocument.query(trx).insert({
            user_id,
            doc_category: 'IDENTITY',
            doc_type: 'IDENTITY_PROOF',
            file_url: documents.id_url,
          });
        }
      }

      if (documents?.contract_agreement_url) {
        const existingContract = await UserDocument.query(trx).findOne({
          user_id,
          doc_type: 'CONTRACT_AGREEMENT',
        });

        if (existingContract) {
          await UserDocument.query(trx)
            .patch({ file_url: documents.contract_agreement_url })
            .where({ id: existingContract.id });
        } else {
          await UserDocument.query(trx).insert({
            user_id,
            doc_category: 'LEGAL',
            doc_type: 'CONTRACT_AGREEMENT',
            file_url: documents.contract_agreement_url,
          });
        }
      }

      // Process general document list - allows uploading any document type
      // This enables 2-API-call flow: upload files → send URLs to compliance
      if (document_list && document_list.length > 0) {
        for (const doc of document_list) {
          // Check if document of this type already exists
          const existingDoc = await UserDocument.query(trx).findOne({
            user_id,
            doc_category: doc.doc_category,
            doc_type: doc.doc_type,
          });

          if (existingDoc) {
            // Update existing document
            await UserDocument.query(trx)
              .patch({ file_url: doc.file_url })
              .where({ id: existingDoc.id });
          } else {
            // Create new document
            await UserDocument.query(trx).insert({
              user_id,
              doc_category: doc.doc_category,
              doc_type: doc.doc_type,
              file_url: doc.file_url,
              verification_status: 'PENDING',
            });
          }
        }
      }

      // Update benefits & active status if provided
      const { allowances, benefits, active_employee } = benefitsPayload as any;

      if (allowances || benefits) {
        const benefitRows: { user_id: string; benefit_type: string; enabled: boolean }[] = [];

        if (allowances) {
          if (allowances.transportation !== undefined) {
            benefitRows.push({
              user_id,
              benefit_type: 'ALLOWANCE_TRANSPORT',
              enabled: Boolean(allowances.transportation),
            });
          }
          if (allowances.meal !== undefined) {
            benefitRows.push({
              user_id,
              benefit_type: 'ALLOWANCE_MEAL',
              enabled: Boolean(allowances.meal),
            });
          }
          if (allowances.internet !== undefined) {
            benefitRows.push({
              user_id,
              benefit_type: 'ALLOWANCE_INTERNET',
              enabled: Boolean(allowances.internet),
            });
          }
        }

        if (benefits) {
          if (benefits.health_insurance !== undefined) {
            benefitRows.push({
              user_id,
              benefit_type: 'BENEFIT_HEALTH_INSURANCE',
              enabled: Boolean(benefits.health_insurance),
            });
          }
          if (benefits.life_insurance !== undefined) {
            benefitRows.push({
              user_id,
              benefit_type: 'BENEFIT_LIFE_INSURANCE',
              enabled: Boolean(benefits.life_insurance),
            });
          }
          if (benefits.company_device !== undefined) {
            benefitRows.push({
              user_id,
              benefit_type: 'BENEFIT_COMPANY_DEVICE',
              enabled: Boolean(benefits.company_device),
            });
          }
          if (benefits.training_program !== undefined) {
            benefitRows.push({
              user_id,
              benefit_type: 'BENEFIT_TRAINING',
              enabled: Boolean(benefits.training_program),
            });
          }
          if (benefits.tuition !== undefined) {
            benefitRows.push({
              user_id,
              benefit_type: 'BENEFIT_TUITION',
              enabled: Boolean(benefits.tuition),
            });
          }
          if (benefits.fitness_membership !== undefined) {
            benefitRows.push({
              user_id,
              benefit_type: 'BENEFIT_FITNESS',
              enabled: Boolean(benefits.fitness_membership),
            });
          }
          if (benefits.mental_health_support !== undefined) {
            benefitRows.push({
              user_id,
              benefit_type: 'BENEFIT_MENTAL_HEALTH_SUPPORT',
              enabled: Boolean(benefits.mental_health_support),
            });
          }
        }

        for (const row of benefitRows) {
          await EmployeeBenefit.query(trx)
            .insert(row)
            .onConflict(['user_id', 'benefit_type'])
            .merge({ enabled: row.enabled });
        }
      }

      if (active_employee !== undefined) {
        await User.query(trx)
          .patch({
            status: 'IN_PROGRESS',
          })
          .where({ id: user_id });
      }

      // Generate temp password inside transaction for atomicity (one-time welcome email)
      if (sendWelcomeEmailRequested && !isEmailBlocked) {
        const lockedWelcome = await loadUserForWelcomeEmailLock(trx, user_id);
        if (!lockedWelcome) {
          throw new Error('User not found');
        }
        if (hasEmployeeWelcomeEmailBeenSent(lockedWelcome)) {
          return;
        }

        // Admin/HR with an existing cross-org password: keep shared creds, skip welcome email.
        if (isAdminOrHrRole(lockedWelcome.role) && lockedWelcome.official_email) {
          const sibling = await findExistingAdminHrCredential(lockedWelcome.official_email, {
            trx,
            excludeOrgId: lockedWelcome.org_id,
          });
          if (sibling) {
            await User.query(trx).patchAndFetchById(user_id, {
              password_hash: sibling.password_hash,
              must_change_password: sibling.must_change_password,
            });
            await markEmployeeWelcomeEmailSent(trx, user_id);
            return;
          }
        }

        tempPassword = generateTempPassword();
        const password_hash = await bcrypt.hash(tempPassword, 10);

        const datas = await User.query(trx).patchAndFetchById(user_id, {
          password_hash,
          must_change_password: true,
        });

        if (!datas) {
          throw new Error('User not found');
        }

        if (isAdminOrHrRole(datas.role)) {
          await syncAdminHrPasswordByEmail(
            datas.official_email,
            { password_hash, must_change_password: true },
            { exceptUserId: datas.id, trx },
          );
        }

        // Fetch organization name and admin/hr name for email
        const organization = await Organization.query(trx).findById(datas.org_id);
        const orgName = organization?.name ?? 'Your Organization';

        // Get the admin/hr name who is completing the onboarding
        const adminUser = req.user;
        const adminName = adminUser
          ? `${adminUser.first_name} ${adminUser.last_name}`.trim() || 'Admin'
          : 'Admin';

        try {
          await sendMsg91Email({
            toEmail: datas.official_email,
            toName: `${datas.first_name} ${datas.last_name}`,
            templateId: 'employee_welcome_email',
            variables: {
              ORG_NAME: orgName,
              ADMIN_NAME: adminName,
              EMPLOYEE_NAME: `${datas.first_name} ${datas.last_name}`,
              LOGIN_EMAIL: datas.official_email,
              TEMP_PASSWORD: tempPassword,
              WEB_LOGIN_URL: process.env.WEB_LOGIN_URL ?? '',
              IOS_APP_URL: process.env.IOS_APP_URL ?? '',
              ANDROID_APP_URL: process.env.ANDROID_APP_URL ?? '',
            },
          });
          await markEmployeeWelcomeEmailSent(trx, user_id);
        } catch (error) {
          // Log error but don't fail the request; allow retry until email succeeds
          // eslint-disable-next-line no-console
          console.error('Failed to send welcome email to employee:', error);
        }
      }
    });

    // When onboarding first becomes COMPLETED, trigger automatic payroll
    // generation for the current month for this user. This is asynchronous
    // and idempotent per (user, month, year), so it is safe to call here.
    if (justCompletedNow && req.user.org_id) {
      generateCurrentMonthPayrollForUser(user_id, req.user.org_id).catch((err) => {
        logger.error(
          { err, user_id, org_id: req.user.org_id },
          'Failed to generate current month payroll after onboarding completion',
        );
      });
    }

    // After compliance updates, trigger KYC verification (best-effort, non-blocking).
    // This allows transition to COMPLETED once KYC becomes VERIFIED.
    if (req.user.org_id) {
      triggerUserKycVerification(req.user.org_id, user_id).catch((err) => {
        logger.error(
          { err, user_id, org_id: req.user.org_id },
          'Failed to trigger KYC verification after compliance update',
        );
      });

      syncAdminHrOnboardingComplianceForUserIfApplicable({
        userId: user_id,
        orgId: req.user.org_id,
      }).catch((err) => {
        logger.error(
          { err, user_id, org_id: req.user.org_id },
          'Failed to sync admin/hr compliance fields across orgs',
        );
      });
    }

    return res.json({
      message: 'Compliance updated successfully',
      onboarding_status,
      ...(tempPassword ? { temp_password: tempPassword } : {}),
    });
  }

  static async updateProfile(req: Request, res: Response): Promise<Response> {
    const user_id = await OnboardingController.resolveTargetUserId(req, res);
    if (!user_id) return res as Response;

    const { user: _ignoredUser, emergency_contacts, addresses, ...rawProfileData } = req.body;

    const restrictedFields = [
      'first_name',
      'last_name',
      'official_email',
      'date_of_joining',
      'designation',
      'org_id',
      'id',
      'user_id',
    ];

    const profileData = Object.keys(rawProfileData)
      .filter((key) => !restrictedFields.includes(key))
      .reduce((obj, key) => {
        obj[key] = rawProfileData[key];
        return obj;
      }, {} as any);

    if (Object.prototype.hasOwnProperty.call(profileData, 'personal_phone')) {
      const normalized = normalizeIndianPhone10Digits((profileData as any).personal_phone);
      (profileData as any).personal_phone = normalized ?? (profileData as any).personal_phone;
    }
    if (Object.prototype.hasOwnProperty.call(profileData, 'alt_phone')) {
      const normalized = normalizeIndianPhone10Digits((profileData as any).alt_phone);
      (profileData as any).alt_phone = normalized ?? (profileData as any).alt_phone;
    }

    // Normalize and validate gender before DB patch to avoid check-constraint errors.
    if (Object.prototype.hasOwnProperty.call(profileData, 'gender')) {
      const normalizedGender = normalizeProfileGender(profileData.gender);
      if (normalizedGender === undefined) {
        return res.status(400).json({
          message: 'Invalid gender. Allowed values: MALE, FEMALE, OTHER',
        });
      }
      profileData.gender = normalizedGender;
    }

    try {
      await Model.transaction(async (trx) => {
        if (Object.keys(profileData).length > 0) {
          const existingProfile = await UserProfile.query(trx).findOne({ user_id });
          if (existingProfile) {
            await UserProfile.query(trx).patch(profileData).where({ user_id });
          } else {
            await UserProfile.query(trx).insert({
              user_id,
              ...profileData,
            });
          }
        }

        if (emergency_contacts && Array.isArray(emergency_contacts)) {
          await EmergencyContact.query(trx).delete().where({ user_id });
          if (emergency_contacts.length > 0) {
            await EmergencyContact.query(trx).insert(
              emergency_contacts.map((c: any) => ({ ...c, user_id })),
            );
          }
        }

        if (addresses && Array.isArray(addresses)) {
          await Address.query(trx).delete().where({ user_id });
          if (addresses.length > 0) {
            await Address.query(trx).insert(addresses.map((a: any) => ({ ...a, user_id })));
          }
        }
      });

      if (req.user?.org_id) {
        syncAdminHrOnboardingComplianceForUserIfApplicable({
          userId: user_id,
          orgId: req.user.org_id,
        }).catch((err) => {
          logger.error(
            { err, user_id, org_id: req.user.org_id },
            'Failed to sync admin/hr profile fields across orgs',
          );
        });
      }

      return OnboardingController.getState(req, res);
    } catch (error) {
      logger.error({ err: error }, 'Update Profile Error');
      return res.status(500).json({ message: 'Failed to update profile details' });
    }
  }

  /**
   * Admin/HR/Manager: Update a user's core onboarding profile fields (Step 1-like fields).
   * This updates the `users` table (name/email/role/department) and stores phone into
   * `user_profiles.personal_phone` as 10 digits (India-only for now).
   */
  static async updateOnboardingProfileAdmin(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    if (req.user.role !== 'admin' && req.user.role !== 'hr' && req.user.role !== 'manager') {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const user_id = await OnboardingController.resolveTargetUserId(req, res);
    if (!user_id) return res as Response;

    const parsed = onboardingAdminProfileUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { email, firstName, lastName, employeeType, department_id, phone } = parsed.data;
    const org_id = req.user.org_id;

    if (department_id) {
      const dept = await Department.query().findOne({ id: department_id, org_id });
      if (!dept) {
        return res.status(400).json({ message: 'Invalid department_id' });
      }
    }

    if (email) {
      const existingEmail = await User.query()
        .where({ org_id, official_email: email })
        .whereNot('id', user_id)
        .first();
      if (existingEmail) {
        return res.status(409).json({ message: 'Email already exists' });
      }
    }

    const normalizedPhone = normalizeIndianPhone10Digits(phone);

    await Model.transaction(async (trx) => {
      const userPatch: any = {};
      if (email !== undefined) userPatch.official_email = email;
      if (firstName !== undefined) userPatch.first_name = firstName;
      if (lastName !== undefined) userPatch.last_name = lastName;
      if (employeeType !== undefined) userPatch.role = employeeType;
      if (department_id !== undefined) userPatch.department_id = department_id;

      if (Object.keys(userPatch).length > 0) {
        const updated = await User.query(trx).patch(userPatch).where({ id: user_id, org_id });
        if (updated === 0) {
          throw new Error('User not found or access denied');
        }
      }

      if (phone !== undefined) {
        const profile = await UserProfile.query(trx).findOne({ user_id });
        const profilePatch: any = { personal_phone: normalizedPhone ?? undefined };
        if (profile) {
          await UserProfile.query(trx).patch(profilePatch).where({ user_id });
        } else {
          await UserProfile.query(trx).insert({ user_id, ...profilePatch } as any);
        }
      }
    }).catch((err: any) => {
      if (err?.message === 'User not found or access denied') {
        throw err;
      }
      throw err;
    });

    syncAdminHrOnboardingComplianceForUserIfApplicable({
      userId: user_id,
      orgId: org_id,
    }).catch((err) => {
      logger.error({ err, user_id, org_id }, 'Failed to sync admin/hr profile fields across orgs');
    });

    return OnboardingController.getState(req, res);
  }

  static async uploadDocumentEmployee(req: any, res: Response) {
    const user_id = req.user.id;
    const org_id = req.user.org_id;
    const s3Uploads = req.s3Uploads as any[];

    if (!s3Uploads || s3Uploads.length === 0) {
      return res.status(200).json({ message: 'No documents provided' });
    }

    try {
      const documents = await UserDocument.transaction(async (trx) => {
        const results = [];
        const incomingDocTypes = [...new Set(s3Uploads.map((u) => u.doc_type))] as string[];

        await UserDocument.query(trx)
          .delete()
          .where('user_id', user_id)
          .whereIn('doc_type', incomingDocTypes);

        for (const upload of s3Uploads) {
          const doc = await UserDocument.query(trx).insert({
            user_id,
            doc_category: upload.doc_category,
            doc_type: upload.doc_type,
            file_url: upload.file_url,
            file_key: upload.file_key,
            verification_status: 'PENDING',
            uploaded_by: user_id,
          });
          results.push(doc);
        }
        return results;
      });

      const passportPhoto = documents.find(
        (doc) => doc.doc_type === 'PASSPORT_SIZE_PHOTO' && doc.file_key,
      );
      if (passportPhoto && org_id && env.S3_BUCKET) {
        try {
          await indexUserFaceFromS3(
            org_id,
            user_id,
            env.S3_BUCKET,
            passportPhoto.file_key as string,
            { rethrow: true },
          );
        } catch (err: unknown) {
          const createdIds = documents.map((d) => d.id).filter(Boolean);
          if (createdIds.length > 0) {
            await UserDocument.query()
              .delete()
              .whereIn('id', createdIds as string[]);
          }

          await cleanupUploadedS3Keys(
            s3Uploads.map((u) => String(u?.file_key ?? '')).filter((k) => k.length > 0),
          );

          const { status, message } = getPassportPhotoFaceIndexErrorResponse(err);
          return res.status(status).json({ message });
        }
      }

      syncAdminHrOnboardingComplianceForUserIfApplicable({
        userId: user_id,
        orgId: org_id,
        role: req.user?.role,
        email: req.user?.official_email,
      }).catch((err) => {
        logger.error({ err, user_id, org_id }, 'Failed to sync admin/hr documents across orgs');
      });

      return res.status(201).json({
        message: 'Documents uploaded successfully',
        data: documents,
      });
    } catch (error: unknown) {
      return res.status(500).json({
        message: 'Failed to save document records',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Admin / HR: Get employee documents in a fixed structure with grouping.
   */
  static async getEmployeeDocumentsAdmin(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { userId } = req.params as { userId?: string };
    if (!userId) {
      return res.status(400).json({ message: 'userId is required' });
    }

    const org_id = req.user.org_id;

    const user = await User.query()
      .where('org_id', org_id)
      .where('id', userId)
      .whereNull('deleted_at')
      .first();

    if (!user) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const parsedQuery = onboardingDocumentsSummaryQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsedQuery.error.flatten().fieldErrors,
      });
    }
    const { page, limit, search } = parsedQuery.data;

    const baseDocsQuery = UserDocument.query()
      .where({ user_id: user.id })
      .whereNotNull('file_key')
      .where('uploaded_by', user.id)
      .modify((qb) => {
        if (search) {
          const term = `%${search}%`;
          qb.andWhere((b) => {
            b.where('doc_type', 'ilike', term)
              .orWhere('doc_category', 'ilike', term)
              .orWhere('file_key', 'ilike', term);
          });
        }
      });

    const totalRow = await baseDocsQuery.clone().count('* as count').first();
    const total_count = Number((totalRow as unknown as { count?: string | number })?.count ?? 0);
    const total_pages = Math.max(1, Math.ceil(total_count / limit));
    const safePage = Math.min(Math.max(page, 1), total_pages);
    const offset = (safePage - 1) * limit;

    const docs = await baseDocsQuery
      .clone()
      .orderBy('created_at', 'asc')
      .offset(offset)
      .limit(limit);

    const formatIso = (value: Date | string | null | undefined): string | null => {
      if (!value) return null;
      const d = typeof value === 'string' ? new Date(value) : value;
      if (Number.isNaN(d.getTime())) return null;
      return d.toISOString();
    };

    const documents = docs.map((d) => ({
      doc_category: d.doc_category,
      doc_type: d.doc_type,
      file_url: d.file_url,
      file_key: d.file_key ?? null,
      verification_status: d.verification_status ?? 'N/A',
      uploaded_at: formatIso(d.created_at as any),
    }));

    const grouped_by_category: Record<string, any[]> = {};
    for (const doc of documents) {
      if (!grouped_by_category[doc.doc_category]) {
        grouped_by_category[doc.doc_category] = [];
      }
      grouped_by_category[doc.doc_category].push({
        doc_type: doc.doc_type,
        file_url: doc.file_url,
        file_key: doc.file_key,
        verification_status: doc.verification_status,
        uploaded_at: doc.uploaded_at,
      });
    }

    return res.json({
      message: 'Documents retrieved successfully',
      data: {
        documents,
        grouped_by_category,
        page: safePage,
        limit,
        total_count,
        total_pages,
        search: search ?? null,
      },
    });
  }

  /**
   * Manager-only composite endpoint:
   * - profile: same data shape as GET /api/onboarding/:userId/profile
   * - documents_summary: same data shape as GET /api/onboarding/:userId/documents-summary
   * - leaves: UI-ready leave summary (dynamic leave types, annual) + month-wise calendar
   */
  static async getEmployeeManagerOverview(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { userId } = req.params as { userId?: string };
    if (!userId) {
      return res.status(400).json({ message: 'userId is required' });
    }

    const org_id = req.user.org_id;

    const user = await User.query()
      .where('org_id', org_id)
      .where('id', userId)
      .whereNull('deleted_at')
      .select(
        'id',
        'org_id',
        'employee_id',
        'first_name',
        'last_name',
        'official_email',
        'status',
        'department_id',
        'designation',
        'date_of_joining',
        'profile_image_url',
      )
      .first();

    if (!user) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    if (req.user.role === 'manager') {
      const managedDepartmentIds = await getManagedDepartmentIds(org_id, req.user.id);
      if (!user.department_id || !managedDepartmentIds.includes(user.department_id)) {
        return res.status(403).json({ message: 'Forbidden' });
      }
    }

    const [profile, emergency_contacts, addresses, docsRaw, employmentDetails, department] =
      await Promise.all([
        UserProfile.query().findOne({ user_id: user.id }),
        EmergencyContact.query().where({ user_id: user.id }),
        Address.query().where({ user_id: user.id }),
        UserDocument.query()
          .where({ user_id: user.id })
          .whereNotNull('file_key')
          .where('uploaded_by', user.id)
          .orderBy('created_at', 'desc'),
        EmployeeEmploymentDetail.query().findOne({ user_id: user.id }),
        user.department_id
          ? Department.query().findById(user.department_id)
          : Promise.resolve(null),
      ]);

    const formatDate = (value: Date | string | null | undefined): string | null => {
      if (!value) return null;
      const d = typeof value === 'string' ? new Date(value) : value;
      if (Number.isNaN(d.getTime())) return null;

      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };

    const profileData = {
      user_id: String(user.id),
      employee_id: user.employee_id ?? null,
      first_name: user.first_name ?? null,
      last_name: user.last_name ?? null,
      official_email: user.official_email ?? null,
      profile_image_url: user.profile_image_url ?? null,
      status: user.status ?? null,
      department_name: department?.name ?? null,
      employment_type: employmentDetails?.employment_type ?? null,
      work_mode: employmentDetails?.work_mode ?? null,
      personal_email: profile?.personal_email ?? null,
      phone_number: profile?.personal_phone ?? null,
      alternate_phone_number: profile?.alt_phone ?? null,
      date_of_birth: formatDate(profile?.dob),
      gender: profile?.gender ?? null,
      marital_status: profile?.marital_status ?? null,
      blood_group: profile?.blood_group ?? null,
      nationality: profile?.nationality ?? null,
      designation: user.designation ?? null,
      date_of_joining: formatDate(user.date_of_joining as any),
      joining_date: formatDate(user.date_of_joining as any),
      emergency_contacts: emergency_contacts.map((c) => ({
        id: String(c.id),
        user_id: String(c.user_id),
        name: c.name,
        relationship: (c as any).relation ?? null,
        phone_number: (c as any).phone ?? null,
        email: c.email ?? null,
      })),
      addresses: OnboardingController.buildProfileAddressesList(String(user.id), addresses),
    };

    const formatIso = (value: Date | string | null | undefined): string | null => {
      if (!value) return null;
      const d = typeof value === 'string' ? new Date(value) : value;
      if (Number.isNaN(d.getTime())) return null;
      return d.toISOString();
    };

    // Deduplicate documents by doc_type (latest upload per type)
    const latestByType = new Map<string, (typeof docsRaw)[number]>();
    for (const d of docsRaw as any[]) {
      const key = d.doc_type ?? '';
      if (!key) continue;
      if (!latestByType.has(key)) {
        latestByType.set(key, d);
      }
    }
    const docs = Array.from(latestByType.values());

    const documents = docs.map((d) => ({
      doc_category: d.doc_category,
      doc_type: d.doc_type,
      file_url: d.file_url,
      file_key: d.file_key ?? null,
      verification_status: d.verification_status ?? 'N/A',
      uploaded_at: formatIso(d.created_at as any),
    }));

    const grouped_by_category: Record<string, any[]> = {};
    for (const doc of documents) {
      if (!grouped_by_category[doc.doc_category]) {
        grouped_by_category[doc.doc_category] = [];
      }
      grouped_by_category[doc.doc_category].push({
        doc_type: doc.doc_type,
        file_url: doc.file_url,
        file_key: doc.file_key,
        verification_status: doc.verification_status,
        uploaded_at: doc.uploaded_at,
      });
    }

    const formatDateLocal = (date: Date | string): string => {
      const d = typeof date === 'string' ? new Date(date) : date;
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };
    const getYearRange = (year: number): { start: string; end: string } => {
      const start = new Date(Date.UTC(year, 0, 1));
      const end = new Date(Date.UTC(year, 11, 31));
      return {
        start: start.toISOString().slice(0, 10),
        end: end.toISOString().slice(0, 10),
      };
    };

    const now = new Date();
    const annualYear = now.getFullYear();
    const { start: yearStart, end: yearEnd } = getYearRange(annualYear);

    const [leaveTypes, yearLeaves] = await Promise.all([
      LeaveType.query().where('org_id', org_id).orderBy('name', 'asc'),
      LeaveRequest.query()
        .where('org_id', org_id)
        .where('user_id', user.id)
        .where((qb) => {
          qb.whereBetween('start_date', [yearStart, yearEnd])
            .orWhereBetween('end_date', [yearStart, yearEnd])
            .orWhere((subQb) => {
              subQb.where('start_date', '<=', yearStart).where('end_date', '>=', yearEnd);
            });
        })
        .whereIn('status', ['PENDING', 'APPROVED']),
    ]);

    const managedScheduleByManagerId =
      user.role === 'manager'
        ? await fetchPrimaryManagedDepartmentScheduleByManagerIds(org_id, [user.id])
        : undefined;
    const leaveSchedule = resolveLeaveScheduleForRow(
      {
        role: user.role,
        department_id: user.department_id,
        department_working_days: department?.working_days,
        user_id: user.id,
      },
      managedScheduleByManagerId,
    );
    const yearHolidaySet = await fetchEffectiveHolidayDateSet(org_id, user.id, yearStart, yearEnd);

    const leaveSummaryByType = new Map<
      string,
      { approved_days: number; pending_days: number; quota: number }
    >();
    const doj = user.date_of_joining ?? '2000-01-01';
    for (const leaveType of leaveTypes) {
      const effectiveQuota = calculateEffectiveQuota(leaveType.annual_quota, doj, annualYear);
      leaveSummaryByType.set(leaveType.id, {
        approved_days: 0,
        pending_days: 0,
        quota: effectiveQuota,
      });
    }

    for (const leave of yearLeaves) {
      const leaveStart = formatDateLocal(leave.start_date);
      const leaveEnd = formatDateLocal(leave.end_date);
      const overlapStart = leaveStart > yearStart ? leaveStart : yearStart;
      const overlapEnd = leaveEnd < yearEnd ? leaveEnd : yearEnd;
      const rangeDays = await countLeaveDaysInRange({
        org_id,
        startDate: overlapStart,
        endDate: overlapEnd,
        departmentId: leaveSchedule.departmentId,
        workingDays: leaveSchedule.workingDays,
        holidaySet: yearHolidaySet,
      });
      const days = applyDaySessionFactor(rangeDays, (leave as any).day_session);
      if (days <= 0) continue;

      const typeData = leaveSummaryByType.get(leave.leave_type_id);
      if (typeData) {
        if (leave.status === 'APPROVED') {
          typeData.approved_days += days;
        } else if (leave.status === 'PENDING') {
          typeData.pending_days += days;
        }
      }
    }

    let allLeavesUsed = 0;
    let allLeavesQuota = 0;
    const dynamicLeaveSummary: Record<string, { used: number; quota: number }> = {};
    const dynamicTypesSummary: Array<{ id: string; name: string; used: number; quota: number }> =
      [];

    for (const leaveType of leaveTypes) {
      const typeData = leaveSummaryByType.get(leaveType.id);
      const used = typeData?.approved_days ?? 0;
      const quota = typeData?.quota ?? 0;
      allLeavesUsed += used;
      allLeavesQuota += quota;

      const normalizedName = leaveType.name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
      const summaryKey = `${normalizedName || leaveType.id}_leaves`;
      dynamicLeaveSummary[summaryKey] = { used, quota };
      dynamicTypesSummary.push({
        id: leaveType.id,
        name: leaveType.name,
        used,
        quota,
      });
    }

    return res.json({
      data: {
        profile: {
          data: profileData,
        },
        documents_summary: {
          data: {
            documents,
            grouped_by_category,
            total_count: documents.length,
          },
        },
        leaves: {
          leave_summary: {
            all_leaves: {
              used: allLeavesUsed,
              quota: allLeavesQuota,
            },
            ...dynamicLeaveSummary,
            types: dynamicTypesSummary,
          },
        },
      },
    });
  }

  // Helper function to resolve shift for a user
  private static async resolveShift(org_id: string, user_id: string) {
    const user = await User.query()
      .withGraphJoined('[shift, department.defaultShift]')
      .where('users.id', user_id)
      .where('users.org_id', org_id)
      .first();

    const department = (user as User & { department?: { defaultShift?: any } })?.department;
    return (user as User & { shift?: any })?.shift ?? department?.defaultShift ?? null;
  }

  // Helper function to calculate break seconds
  private static calculateBreakSeconds(
    breaks: Array<{ start_time: string; end_time?: string | null }>,
    now: Date = new Date(),
  ): number {
    return breaks.reduce((total, entry) => {
      const start = new Date(entry.start_time);
      const end = entry.end_time ? new Date(entry.end_time) : now;
      const diff = Math.max(0, end.getTime() - start.getTime());
      return total + Math.round(diff / 1000);
    }, 0);
  }

  // Helper function to calculate work seconds
  private static calculateWorkSeconds(
    clockInTime: string | null | undefined,
    clockOutTime: string | null | undefined,
    breaks: Array<{ start_time: string; end_time?: string | null }> = [],
  ): number {
    if (!clockInTime) {
      return 0;
    }

    const clockInDate = new Date(clockInTime);
    if (Number.isNaN(clockInDate.getTime())) {
      return 0;
    }

    const endDate = clockOutTime ? new Date(clockOutTime) : new Date();
    if (Number.isNaN(endDate.getTime())) {
      return 0;
    }

    const grossMs = Math.max(0, endDate.getTime() - clockInDate.getTime());
    const breakSeconds = OnboardingController.calculateBreakSeconds(breaks, endDate);
    const netMs = Math.max(0, grossMs - breakSeconds * 1000);

    return Math.round(netMs / 1000);
  }

  // Helper function to calculate late arrival (aligned with AttendanceController)
  private static calculateLateArrival(
    clockInTime: string | null | undefined,
    shiftStartTime: string | null | undefined,
    graceMins: number = DEFAULT_LATE_GRACE_PERIOD_MINS,
  ): { isLate: boolean; lateByMinutes: number } {
    if (!clockInTime || !shiftStartTime) {
      return { isLate: false, lateByMinutes: 0 };
    }

    try {
      const clockInDate = new Date(clockInTime);
      if (Number.isNaN(clockInDate.getTime())) {
        return { isLate: false, lateByMinutes: 0 };
      }

      // Convert UTC clock-in time to IST for comparison with shift time (which is in IST)
      const istClockInDate = new Date(clockInDate.getTime() + IST_OFFSET_MS);
      const clockInMinutes = istClockInDate.getUTCHours() * 60 + istClockInDate.getUTCMinutes();
      const shiftStartMinutes = parseTimeToMinutes(shiftStartTime);

      if (shiftStartMinutes === 0) {
        return { isLate: false, lateByMinutes: 0 };
      }

      const diff = clockInMinutes - shiftStartMinutes;

      if (diff > graceMins) {
        return { isLate: true, lateByMinutes: diff };
      }

      return { isLate: false, lateByMinutes: 0 };
    } catch {
      return { isLate: false, lateByMinutes: 0 };
    }
  }

  // Helper function to calculate overtime seconds
  private static calculateOvertimeSeconds(
    totalWorkSeconds: number,
    shiftStartTime: string | null | undefined,
    shiftEndTime: string | null | undefined,
  ): number {
    if (!shiftStartTime || !shiftEndTime || totalWorkSeconds <= 0) {
      return 0;
    }

    try {
      const [startHours, startMinutes] = shiftStartTime.split(':').map(Number);
      const [endHours, endMinutes] = shiftEndTime.split(':').map(Number);
      const shiftDurationSeconds =
        endHours * 3600 + endMinutes * 60 - (startHours * 3600 + startMinutes * 60);

      if (totalWorkSeconds > shiftDurationSeconds) {
        return totalWorkSeconds - shiftDurationSeconds;
      }

      return 0;
    } catch {
      return 0;
    }
  }

  // Helper function to fetch attendance data
  private static async fetchAttendanceData(
    org_id: string,
    user_id: string,
    startDate: string,
    endDate: string,
  ) {
    // Fetch attendance logs
    const logs = await AttendanceLog.query()
      .where('org_id', org_id)
      .where('user_id', user_id)
      .whereBetween('date', [startDate, endDate])
      .orderBy('date', 'asc');

    // Fetch pending correction requests
    const pendingRequests = await AttendanceCorrectionRequest.query()
      .where('user_id', user_id)
      .where('status', 'PENDING')
      .whereBetween('request_date', [startDate, endDate]);

    const pendingRequestsByDate = new Map<string, AttendanceCorrectionRequest>();
    for (const request of pendingRequests) {
      pendingRequestsByDate.set(request.request_date, request);
    }

    // Fetch approved leaves overlapping the requested range
    const approvedLeaves = await LeaveRequest.query()
      .where('org_id', org_id)
      .where('user_id', user_id)
      .where('status', 'APPROVED')
      .where((qb) => {
        qb.whereBetween('start_date', [startDate, endDate])
          .orWhereBetween('end_date', [startDate, endDate])
          .orWhere((subQb) => {
            subQb.where('start_date', '<=', startDate).where('end_date', '>=', endDate);
          });
      });

    const approvedLeavesByDate = new Set<string>();
    for (const leave of approvedLeaves) {
      const start = new Date(leave.start_date);
      const end = new Date(leave.end_date);
      const cursor = new Date(start);
      while (cursor <= end) {
        const key = formatDateLocal(cursor);
        if (key >= startDate && key <= endDate) {
          approvedLeavesByDate.add(key);
        }
        cursor.setDate(cursor.getDate() + 1);
      }
    }

    // Create a map of dates to logs
    const logsByDate = new Map<string, AttendanceLog>();
    const logIds: string[] = [];
    for (const log of logs) {
      const normalizedDate = normalizeDate(log.date);
      if (normalizedDate) {
        logsByDate.set(normalizedDate, log);
      }
      logIds.push(String((log as any).id));
    }

    // Fetch all breaks
    const allBreaks =
      logIds.length > 0
        ? await AttendanceBreak.query()
            .whereIn('attendance_log_id', logIds)
            .select('attendance_log_id', 'start_time', 'end_time')
        : [];

    const breaksByLogId = new Map<
      string,
      Array<{ start_time: string; end_time?: string | null }>
    >();
    for (const breakEntry of allBreaks) {
      const logId = String((breakEntry as any).attendance_log_id);
      if (!breaksByLogId.has(logId)) {
        breaksByLogId.set(logId, []);
      }
      breaksByLogId.get(logId)!.push({
        start_time: (breakEntry as any).start_time,
        end_time: (breakEntry as any).end_time,
      });
    }

    // Get shift info
    const shift = await OnboardingController.resolveShift(org_id, user_id);
    const shiftBreakLimit = shift?.break_duration_mins ?? 0;
    const shiftStartTime = shift?.start_time ?? null;
    const shiftEndTime = shift?.end_time ?? null;

    return {
      logs,
      logsByDate,
      approvedLeavesByDate,
      breaksByLogId,
      pendingRequestsByDate,
      shift,
      shiftBreakLimit,
      shiftStartTime,
      shiftEndTime,
    };
  }

  // Get employee calendar for manager overview
  static async getEmployeeCalendar(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { userId } = req.params as { userId?: string };
    if (!userId) {
      return res.status(400).json({ message: 'userId is required' });
    }

    const org_id = req.user.org_id;

    // Validate query parameters
    const parsed = attendanceCalendarQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { month, year, start_date, end_date } = parsed.data;

    const lateGracePeriodMins = await getOrgLateGracePeriodMins(org_id);

    // Calculate date range
    let startDate: string;
    let endDate: string;

    if (start_date && end_date) {
      startDate = start_date;
      endDate = end_date;
    } else if (month && year) {
      startDate = `${year}-${String(month).padStart(2, '0')}-01`;
      const lastDay = new Date(year, month, 0).getDate();
      endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    } else {
      return res
        .status(400)
        .json({ message: 'Either provide month and year, or start_date and end_date' });
    }

    // Verify user exists and manager has access
    const user = await User.query()
      .where('org_id', org_id)
      .where('id', userId)
      .whereNull('deleted_at')
      .select('id', 'first_name', 'last_name', 'profile_image_url', 'department_id')
      .first();

    if (!user) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    if (req.user.role === 'manager') {
      const managedDepartmentIds = await getManagedDepartmentIds(org_id, req.user.id);
      if (!user.department_id || !managedDepartmentIds.includes(user.department_id)) {
        return res.status(403).json({ message: 'Forbidden' });
      }
    }

    const [attendancePack, scheduleUser, holidaySet] = await Promise.all([
      OnboardingController.fetchAttendanceData(org_id, userId, startDate, endDate),
      User.query()
        .alias('u')
        .leftJoin('departments as d', 'd.id', 'u.department_id')
        .where('u.id', userId)
        .where('u.org_id', org_id)
        .select('u.date_of_joining', 'u.department_id', 'd.working_days as department_working_days')
        .first(),
      fetchEffectiveHolidayDateSet(org_id, userId, startDate, endDate),
    ]);

    const {
      logsByDate,
      approvedLeavesByDate,
      breaksByLogId,
      pendingRequestsByDate,
      shiftBreakLimit,
      shiftStartTime,
    } = attendancePack;

    let joinDateStr: string | null = null;
    if (scheduleUser && scheduleUser.date_of_joining) {
      const raw = scheduleUser.date_of_joining as any;
      if (raw instanceof Date) {
        joinDateStr = formatDateLocal(raw);
      } else {
        joinDateStr = String(raw).slice(0, 10);
      }
    }

    const scheduleDeptId = scheduleUser?.department_id ?? null;
    const scheduleUserRow = scheduleUser as unknown as {
      department_working_days?: string[] | null;
    } | null;
    const scheduleWorkingDays = Array.isArray(scheduleUserRow?.department_working_days)
      ? scheduleUserRow.department_working_days
      : null;

    // Build calendar entries
    const calendarEntries: Array<{
      date: string;
      status: 'PRESENT' | 'LATE' | 'LEAVE' | 'ABSENT' | 'HOLIDAY';
      is_excess_break?: boolean;
    }> = [];

    const startIST = new Date(`${startDate}T00:00:00+05:30`);
    const endIST = new Date(`${endDate}T23:59:59+05:30`);
    const today = getTodayDate();
    let current = new Date(startIST);

    let presentCount = 0;
    let lateCount = 0;
    let onLeaveCount = 0;
    let absentCount = 0;

    while (current <= endIST) {
      const dateStr = formatDateLocal(current);

      // Skip dates before date_of_joining
      if (joinDateStr && dateStr < joinDateStr) {
        current.setTime(current.getTime() + 24 * 60 * 60 * 1000);
        continue;
      }

      const logEarly = logsByDate.get(dateStr);
      const pendingEarly = pendingRequestsByDate.get(dateStr);
      const isHoliday = holidaySet.has(dateStr);
      const hasLog = Boolean(logEarly);
      const hasPendingCorrection = Boolean(pendingEarly);

      // Org holidays appear as HOLIDAY unless there is a log or pending correction (same as monthly-performance).
      if (isHoliday && !hasLog && !hasPendingCorrection) {
        calendarEntries.push({ date: dateStr, status: 'HOLIDAY' });
        current.setTime(current.getTime() + 24 * 60 * 60 * 1000);
        continue;
      }

      if (
        shouldOmitAttendanceCalendarDate({
          dateStr,
          holidaySet,
          departmentId: scheduleDeptId,
          workingDays: scheduleWorkingDays,
          hasLog,
          hasPendingCorrection,
        })
      ) {
        current.setTime(current.getTime() + 24 * 60 * 60 * 1000);
        continue;
      }

      const isOnLeave = approvedLeavesByDate.has(dateStr);
      const isFutureDate = dateStr > today;

      // For future dates, only include entries where user is on approved leave
      if (isFutureDate && !isOnLeave) {
        current.setTime(current.getTime() + 24 * 60 * 60 * 1000);
        continue;
      }

      if (isOnLeave) {
        calendarEntries.push({ date: dateStr, status: 'LEAVE' });
        onLeaveCount++;
        current.setTime(current.getTime() + 24 * 60 * 60 * 1000);
        continue;
      }

      const log = logEarly;
      const breaks = log ? (breaksByLogId.get(String((log as any).id)) ?? []) : [];

      if (!log) {
        calendarEntries.push({ date: dateStr, status: 'ABSENT' });
        absentCount++;
      } else {
        const totalBreakSeconds = OnboardingController.calculateBreakSeconds(
          breaks,
          log.clock_out_time ? new Date(log.clock_out_time) : new Date(),
        );
        const isExcessBreak = shiftBreakLimit > 0 && totalBreakSeconds > shiftBreakLimit * 60;
        const lateInfo = OnboardingController.calculateLateArrival(
          log.clock_in_time,
          shiftStartTime,
          lateGracePeriodMins,
        );

        const status = lateInfo.isLate ? 'LATE' : 'PRESENT';
        calendarEntries.push({ date: dateStr, status, is_excess_break: isExcessBreak });
        if (status === 'LATE') {
          lateCount++;
        } else {
          presentCount++;
        }
      }

      current.setTime(current.getTime() + 24 * 60 * 60 * 1000);
    }

    return res.json({
      employee: {
        id: String(user.id),
        full_name: `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim() || null,
        profile_image_url: user.profile_image_url ?? null,
      },
      calendar: {
        month: month ?? null,
        year: year ?? null,
        from_date: start_date ?? null,
        to_date: end_date ?? null,
        entries: calendarEntries,
        legend: {
          present: presentCount,
          late: lateCount,
          on_leave: onLeaveCount,
          absent: absentCount,
          // Kept for backward compatibility but always 0 after HALF_DAY removal
          half_day: 0,
        },
      },
    });
  }

  // Get employee hours logged for manager overview
  static async getEmployeeHoursLogged(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { userId } = req.params as { userId?: string };
    if (!userId) {
      return res.status(400).json({ message: 'userId is required' });
    }

    const org_id = req.user.org_id;

    // This endpoint uses from_date and to_date only (no month/year)
    const from_date = req.query.from_date as string | undefined;
    const to_date = req.query.to_date as string | undefined;

    if (!from_date || !to_date) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: {
          from_date: !from_date ? ['from_date is required'] : [],
          to_date: !to_date ? ['to_date is required'] : [],
        },
      });
    }

    // Basic YYYY-MM-DD validation
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(from_date) || !dateRegex.test(to_date)) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: {
          from_date: !dateRegex.test(from_date) ? ['from_date must be in YYYY-MM-DD format'] : [],
          to_date: !dateRegex.test(to_date) ? ['to_date must be in YYYY-MM-DD format'] : [],
        },
      });
    }

    const fromDateObj = new Date(from_date);
    const toDateObj = new Date(to_date);
    if (Number.isNaN(fromDateObj.getTime()) || Number.isNaN(toDateObj.getTime())) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: {
          from_date: Number.isNaN(fromDateObj.getTime()) ? ['Invalid from_date'] : [],
          to_date: Number.isNaN(toDateObj.getTime()) ? ['Invalid to_date'] : [],
        },
      });
    }

    if (fromDateObj > toDateObj) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: {
          from_date: ['from_date must be before or equal to to_date'],
        },
      });
    }

    const startDate = from_date;
    const endDate = to_date;

    // Verify user exists and manager has access
    const user = await User.query()
      .where('org_id', org_id)
      .where('id', userId)
      .whereNull('deleted_at')
      .first();

    if (!user) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    if (req.user.role === 'manager') {
      const managedDepartmentIds = await getManagedDepartmentIds(org_id, req.user.id);
      if (!user.department_id || !managedDepartmentIds.includes(user.department_id)) {
        return res.status(403).json({ message: 'Forbidden' });
      }
    }

    // Fetch attendance data
    const { logsByDate, breaksByLogId } = await OnboardingController.fetchAttendanceData(
      org_id,
      userId,
      startDate,
      endDate,
    );

    // Get user join date
    const userWithDoj = await User.query().findById(userId).where('org_id', org_id);
    let joinDateStr: string | null = null;
    if (userWithDoj && userWithDoj.date_of_joining) {
      const raw = userWithDoj.date_of_joining as any;
      if (raw instanceof Date) {
        joinDateStr = formatDateLocal(raw);
      } else {
        joinDateStr = String(raw).slice(0, 10);
      }
    }

    // Build daily hours array
    const daily: Array<{ date: string; day_name: string; seconds: number }> = [];
    let totalSeconds = 0;

    const startIST = new Date(`${startDate}T00:00:00+05:30`);
    const endIST = new Date(`${endDate}T23:59:59+05:30`);
    let current = new Date(startIST);

    while (current <= endIST) {
      const dateStr = formatDateLocal(current);

      // Skip dates before date_of_joining
      if (joinDateStr && dateStr < joinDateStr) {
        current.setTime(current.getTime() + 24 * 60 * 60 * 1000);
        continue;
      }

      const log = logsByDate.get(dateStr);
      const dayName = new Date(dateStr).toLocaleDateString('en-US', { weekday: 'long' });

      if (log) {
        const breaks = breaksByLogId.get(String((log as any).id)) ?? [];
        const workSeconds = OnboardingController.calculateWorkSeconds(
          log.clock_in_time,
          log.clock_out_time,
          breaks,
        );
        daily.push({ date: dateStr, day_name: dayName, seconds: workSeconds });
        totalSeconds += workSeconds;
      } else {
        // No log for this date -> 0 seconds
        daily.push({ date: dateStr, day_name: dayName, seconds: 0 });
      }

      current.setTime(current.getTime() + 24 * 60 * 60 * 1000);
    }

    return res.json({
      hours_logged: {
        total_seconds: totalSeconds,
        daily,
        from_date: startDate,
        to_date: endDate,
      },
    });
  }

  static async upsertBankAndAsset(req: any, res: Response) {
    const user_id = req.user.id;
    const {
      ifsc_code,
      bank_name,
      account_number,
      account_holder_name,
      bank_proof_url,
      bank_proof_key,
      asset_device_pref,
      asset_agreement_accepted,
      device_serial_number,
    } = req.body;

    const bankMedia = req.bankMedia;

    try {
      await Model.transaction(async (trx) => {
        // 1. Build Bank Update Object dynamically
        const bankUpdate: any = { user_id };

        // Only add to object if the data was actually sent in the request
        if (ifsc_code !== undefined) {
          bankUpdate.ifsc_code = ifsc_code;
        }
        if (bank_name !== undefined) bankUpdate.bank_name = bank_name;
        if (account_number !== undefined) {
          bankUpdate.account_number = account_number;
        }
        if (account_holder_name !== undefined) {
          bankUpdate.account_holder_name = account_holder_name;
        }

        // If new media was uploaded via bankMediaUploader middleware
        if (bankMedia) {
          bankUpdate.bank_proof_url = bankMedia.url;
          bankUpdate.bank_proof_key = bankMedia.key;
        }
        // Support metadata-only updates (when client already uploaded to S3)
        if (!bankMedia && typeof bank_proof_url === 'string' && bank_proof_url.trim().length > 0) {
          bankUpdate.bank_proof_url = bank_proof_url.trim();
          if (typeof bank_proof_key === 'string' && bank_proof_key.trim().length > 0) {
            bankUpdate.bank_proof_key = bank_proof_key.trim();
          }
        }

        // Perform upsert for Bank Details
        if (Object.keys(bankUpdate).length > 1) {
          // Only run if fields other than user_id exist
          await BankDetail.query(trx)
            .insert({
              ...bankUpdate,
              verification_status: 'PENDING',
              verification_failure_reason: null,
              verification_checked_at: null,
              verification_provider: null,
              verification_meta: null,
              updated_at: new Date().toISOString(),
            })
            .onConflict('user_id')
            .merge({
              ...bankUpdate,
              verification_status: 'PENDING',
              verification_failure_reason: null,
              verification_checked_at: null,
              verification_provider: null,
              verification_meta: null,
              updated_at: new Date().toISOString(),
            });
        }

        // 2. Build Onboarding (Asset) Update Object dynamically
        const onboardingUpdate: any = { user_id };

        if (typeof asset_device_pref === 'string' && asset_device_pref.trim().length > 0) {
          onboardingUpdate.asset_device_pref = asset_device_pref.trim().toUpperCase();
        }
        if (
          asset_agreement_accepted !== undefined &&
          asset_agreement_accepted !== null &&
          asset_agreement_accepted !== ''
        ) {
          onboardingUpdate.asset_agreement_accepted =
            asset_agreement_accepted === 'true' || asset_agreement_accepted === true;
        }
        if (typeof device_serial_number === 'string' && device_serial_number.trim().length > 0) {
          onboardingUpdate.device_serial_number = device_serial_number.trim();
        }

        // Perform upsert for User Onboarding table
        if (Object.keys(onboardingUpdate).length > 1) {
          await UserOnboarding.query(trx)
            .insert({ ...onboardingUpdate, updated_at: new Date().toISOString() })
            .onConflict('user_id')
            .merge();
        }
      });

      // If onboarding is already completed, bank details update should trigger
      // re-evaluation of full KYC (Aadhaar + PAN + Bank).
      if (req.user?.org_id) {
        const onboarding = await UserOnboarding.query().findOne({ user_id });
        if (onboarding?.onboarding_status === 'COMPLETED') {
          triggerUserKycVerification(req.user.org_id, user_id).catch((err) => {
            logger.error(
              { err, user_id, org_id: req.user.org_id },
              'Failed to trigger KYC verification after bank details update',
            );
          });
        }

        syncAdminHrOnboardingComplianceForUserIfApplicable({
          userId: user_id,
          orgId: req.user.org_id,
          role: req.user.role,
          email: req.user.official_email,
          includeLetterDocs: false,
        }).catch((err) => {
          logger.error(
            { err, user_id, org_id: req.user.org_id },
            'Failed to sync admin/hr asset fields across orgs',
          );
        });
      }

      return res.status(200).json({
        message: 'Details updated successfully for provided fields.',
      });
    } catch (error) {
      logger.error({ err: error, user_id }, 'Failed to upsert bank and asset details');
      return res.status(500).json({ message: 'Failed to update details' });
    }
  }

  /**
   * Admin / HR: Get bank and asset details in a fixed response shape.
   */
  private static formatIso(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    const d = typeof value === 'string' ? new Date(value) : value;
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  }

  private static async buildBankAndAssetResponse(userId: string) {
    const [bank, onboarding, payroll] = await Promise.all([
      BankDetail.query().findOne({ user_id: userId }),
      UserOnboarding.query().findOne({ user_id: userId }),
      UserPayrollDetail.query().findOne({ user_id: userId }),
    ]);

    return {
      bank_details: bank
        ? {
            user_id: String(bank.user_id),
            ifsc_code: bank.ifsc_code ?? null,
            bank_name: bank.bank_name ?? null,
            account_number: bank.account_number ?? null,
            account_holder_name: bank.account_holder_name ?? null,
            bank_proof_url: bank.bank_proof_url ?? null,
            bank_proof_key: bank.bank_proof_key ?? null,
            created_at: OnboardingController.formatIso(bank.created_at as any),
            updated_at: OnboardingController.formatIso(bank.updated_at as any),
          }
        : null,
      asset_details: {
        asset_device_pref: onboarding?.asset_device_pref ?? null,
        asset_agreement_accepted: onboarding?.asset_agreement_accepted ?? false,
        device_serial_number: onboarding?.device_serial_number ?? null,
      },
      payroll_details: {
        uan_number: payroll?.uan_number ?? null,
        pf_number: payroll?.pf_number ?? null,
      },
    };
  }

  static async getBankAndAssetAdmin(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { userId } = req.params as { userId?: string };
    if (!userId) {
      return res.status(400).json({ message: 'userId is required' });
    }

    const org_id = req.user.org_id;

    const user = await User.query()
      .where('org_id', org_id)
      .where('id', userId)
      .whereNull('deleted_at')
      .first();

    if (!user) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const data = await OnboardingController.buildBankAndAssetResponse(user.id);

    return res.json({
      message: 'Bank and asset details retrieved successfully',
      data,
    });
  }

  static async patchBankAndAssetAdmin(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const user_id = await OnboardingController.resolveTargetUserId(req, res);
    if (!user_id) {
      return res as Response;
    }

    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
    const cancelledChequeFile = files?.cancelled_cheque?.[0];
    const hasCancelledCheque = Boolean(cancelledChequeFile);

    const parsed = onboardingBankAndAssetUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    if (!hasCancelledCheque && !hasOnboardingBankAndAssetUpdateFields(parsed.data)) {
      return res.status(400).json({
        message: 'At least one field or cancelled_cheque file must be provided',
      });
    }

    const {
      ifsc_code,
      bank_name,
      account_number,
      account_holder_name,
      asset_device_pref,
      asset_agreement_accepted,
      device_serial_number,
      uan_number,
      pf_number,
    } = parsed.data;

    let cancelledChequeUpload: { file_url: string; file_key: string } | null = null;

    if (hasCancelledCheque && cancelledChequeFile) {
      try {
        cancelledChequeUpload = await uploadCancelledChequeForUser(
          req.user.org_id,
          user_id,
          cancelledChequeFile,
        );
      } catch (error) {
        logger.error({ err: error, user_id }, 'Failed to upload cancelled cheque');
        return res.status(500).json({ message: 'Failed to upload cancelled cheque' });
      }
    }

    const bankFieldsChanged =
      ifsc_code !== undefined ||
      bank_name !== undefined ||
      account_number !== undefined ||
      account_holder_name !== undefined ||
      cancelledChequeUpload !== null;

    try {
      await Model.transaction(async (trx) => {
        const bankUpdate: any = { user_id };

        if (ifsc_code !== undefined) bankUpdate.ifsc_code = ifsc_code;
        if (bank_name !== undefined) bankUpdate.bank_name = bank_name;
        if (account_number !== undefined) bankUpdate.account_number = account_number;
        if (account_holder_name !== undefined) {
          bankUpdate.account_holder_name = account_holder_name;
        }
        if (cancelledChequeUpload) {
          bankUpdate.bank_proof_url = cancelledChequeUpload.file_url;
          bankUpdate.bank_proof_key = cancelledChequeUpload.file_key;
        }

        if (Object.keys(bankUpdate).length > 1) {
          await BankDetail.query(trx)
            .insert({
              ...bankUpdate,
              verification_status: 'PENDING',
              verification_failure_reason: null,
              verification_checked_at: null,
              verification_provider: null,
              verification_meta: null,
              updated_at: new Date().toISOString(),
            })
            .onConflict('user_id')
            .merge({
              ...bankUpdate,
              verification_status: 'PENDING',
              verification_failure_reason: null,
              verification_checked_at: null,
              verification_provider: null,
              verification_meta: null,
              updated_at: new Date().toISOString(),
            });
        }

        const onboardingUpdate: any = { user_id };

        if (asset_device_pref !== undefined) {
          onboardingUpdate.asset_device_pref = asset_device_pref;
        }
        if (asset_agreement_accepted !== undefined) {
          onboardingUpdate.asset_agreement_accepted = asset_agreement_accepted;
        }
        if (device_serial_number !== undefined) {
          onboardingUpdate.device_serial_number = device_serial_number;
        }

        if (Object.keys(onboardingUpdate).length > 1) {
          await UserOnboarding.query(trx)
            .insert({ ...onboardingUpdate, updated_at: new Date().toISOString() })
            .onConflict('user_id')
            .merge();
        }

        if (uan_number !== undefined || pf_number !== undefined) {
          const payrollUpdate: any = { user_id };
          if (uan_number !== undefined) payrollUpdate.uan_number = uan_number;
          if (pf_number !== undefined) payrollUpdate.pf_number = pf_number;

          const existingPayroll = await UserPayrollDetail.query(trx).findOne({ user_id });
          if (existingPayroll) {
            await UserPayrollDetail.query(trx).patch(payrollUpdate).where({ user_id });
          } else {
            await UserPayrollDetail.query(trx).insert(payrollUpdate);
          }
        }
      });

      if (bankFieldsChanged && req.user?.org_id) {
        const onboarding = await UserOnboarding.query().findOne({ user_id });
        if (onboarding?.onboarding_status === 'COMPLETED') {
          triggerUserKycVerification(req.user.org_id, user_id).catch((err) => {
            logger.error(
              { err, user_id, org_id: req.user!.org_id },
              'Failed to trigger KYC verification after bank details update',
            );
          });
        }
      }

      if (req.user?.org_id) {
        syncAdminHrOnboardingComplianceForUserIfApplicable({
          userId: user_id,
          orgId: req.user.org_id,
          includeLetterDocs: false,
        }).catch((err) => {
          logger.error(
            { err, user_id, org_id: req.user!.org_id },
            'Failed to sync admin/hr asset fields across orgs',
          );
        });
      }

      const data = await OnboardingController.buildBankAndAssetResponse(user_id);

      return res.json({
        message: 'Bank and asset details updated successfully',
        data,
      });
    } catch (error) {
      logger.error({ err: error, user_id }, 'Failed to patch bank and asset details');
      return res.status(500).json({ message: 'Failed to update bank and asset details' });
    }
  }

  static async upsertCompliance(req: any, res: Response) {
    const user_id = req.user.id;
    const { policy_acknowledged } = req.body;
    const existingBefore = await UserOnboarding.query().findOne({ user_id });

    const uploads = req.s3Uploads || [];
    const signedLetter = uploads.find((u: any) => u.doc_type === 'SIGNED_JOINING_LETTER');
    let tempPassword: string | undefined;

    try {
      await Model.transaction(async (trx) => {
        const onboardingUpdate: any = {
          user_id,
          updated_at: new Date().toISOString(),
        };

        if (policy_acknowledged !== undefined) {
          onboardingUpdate.policy_acknowledged =
            policy_acknowledged === 'true' || policy_acknowledged === true;
        }

        if (signedLetter) {
          onboardingUpdate.offer_letter_url = signedLetter.file_url;
          onboardingUpdate.offer_letter_signed = true;
        }

        const existingOnboarding = await UserOnboarding.query(trx).findOne({ user_id });
        const effectiveOfferLetterSigned = signedLetter
          ? true
          : Boolean(
              existingOnboarding?.offer_letter_signed || existingOnboarding?.offer_letter_url,
            );
        const hasAdminDocumentsComplete = await OnboardingController.hasAdminStepDocumentsComplete(
          req.user.org_id,
          user_id,
          trx,
        );
        const isKycVerified =
          String(existingOnboarding?.kyc_status ?? '').toUpperCase() === 'VERIFIED';
        // Match GET /api/onboarding `admin_step_completion.documents_complete` (any admin/hr upload).
        const adminDocumentsCompleteLikeGetState =
          await OnboardingController.hasPrivilegedUploadedDocumentsForUser(
            req.user.org_id,
            user_id,
            trx,
          );
        const isEmailBlocked = adminDocumentsCompleteLikeGetState || isKycVerified;
        const kycFlowEnabled = await OnboardingController.isKycFlowEnabledForOrg(req.user.org_id);

        const nextOnboardingStatus = resolveOnboardingStatusFromComplianceAndKyc({
          offerLetterSigned: effectiveOfferLetterSigned,
          kycStatus: existingOnboarding?.kyc_status,
          hasAdminDocumentsComplete,
          kycFlowEnabled,
        });
        onboardingUpdate.onboarding_status = nextOnboardingStatus;
        onboardingUpdate.completed_at =
          nextOnboardingStatus === 'COMPLETED' ? new Date().toISOString() : null;

        await UserOnboarding.query(trx).insert(onboardingUpdate).onConflict('user_id').merge();

        if (signedLetter) {
          const existingDoc = await UserDocument.query(trx).findOne({
            user_id,
            doc_type: 'SIGNED_JOINING_LETTER',
          });

          if (existingDoc) {
            await UserDocument.query(trx)
              .patch({
                file_url: signedLetter.file_url,
                file_key: signedLetter.file_key,
                verification_status: 'PENDING',
              })
              .where('id', existingDoc.id);
          } else {
            await UserDocument.query(trx).insert({
              user_id,
              doc_category: 'LEGAL',
              doc_type: 'SIGNED_JOINING_LETTER',
              file_url: signedLetter.file_url,
              file_key: signedLetter.file_key,
              verification_status: 'PENDING',
            });
          }
        }

        // Mobile compliance submission: send welcome email + temp password unless blocked (one-time).
        if (signedLetter && !isEmailBlocked) {
          const lockedWelcome = await loadUserForWelcomeEmailLock(trx, user_id);
          if (lockedWelcome?.official_email && !hasEmployeeWelcomeEmailBeenSent(lockedWelcome)) {
            if (isAdminOrHrRole(lockedWelcome.role)) {
              const sibling = await findExistingAdminHrCredential(lockedWelcome.official_email, {
                trx,
                excludeOrgId: lockedWelcome.org_id,
              });
              if (sibling) {
                await User.query(trx).patchAndFetchById(user_id, {
                  password_hash: sibling.password_hash,
                  must_change_password: sibling.must_change_password,
                });
                await markEmployeeWelcomeEmailSent(trx, user_id);
              } else {
                tempPassword = generateTempPassword();
                const password_hash = await bcrypt.hash(tempPassword, 10);

                const datas = await User.query(trx).patchAndFetchById(user_id, {
                  password_hash,
                  must_change_password: true,
                });

                if (datas) {
                  await syncAdminHrPasswordByEmail(
                    datas.official_email,
                    { password_hash, must_change_password: true },
                    { exceptUserId: datas.id, trx },
                  );

                  const organization = await Organization.query(trx).findById(datas.org_id);
                  const orgName = organization?.name ?? 'Your Organization';
                  const adminUser = req.user;
                  const adminName = adminUser
                    ? `${adminUser.first_name} ${adminUser.last_name}`.trim() || 'Admin'
                    : 'Admin';

                  try {
                    await sendMsg91Email({
                      toEmail: datas.official_email,
                      toName: `${datas.first_name} ${datas.last_name}`,
                      templateId: 'employee_welcome_email',
                      variables: {
                        ORG_NAME: orgName,
                        ADMIN_NAME: adminName,
                        EMPLOYEE_NAME: `${datas.first_name} ${datas.last_name}`,
                        LOGIN_EMAIL: datas.official_email,
                        TEMP_PASSWORD: tempPassword,
                        WEB_LOGIN_URL: process.env.WEB_LOGIN_URL ?? '',
                        IOS_APP_URL: process.env.IOS_APP_URL ?? '',
                        ANDROID_APP_URL: process.env.ANDROID_APP_URL ?? '',
                      },
                    });
                    await markEmployeeWelcomeEmailSent(trx, user_id);
                  } catch (error) {
                    // eslint-disable-next-line no-console
                    console.error('Failed to send welcome email to employee:', error);
                  }
                }
              }
            } else {
              tempPassword = generateTempPassword();
              const password_hash = await bcrypt.hash(tempPassword, 10);

              const datas = await User.query(trx).patchAndFetchById(user_id, {
                password_hash,
                must_change_password: true,
              });

              if (datas) {
                const organization = await Organization.query(trx).findById(datas.org_id);
                const orgName = organization?.name ?? 'Your Organization';
                const adminUser = req.user;
                const adminName = adminUser
                  ? `${adminUser.first_name} ${adminUser.last_name}`.trim() || 'Admin'
                  : 'Admin';

                try {
                  await sendMsg91Email({
                    toEmail: datas.official_email,
                    toName: `${datas.first_name} ${datas.last_name}`,
                    templateId: 'employee_welcome_email',
                    variables: {
                      ORG_NAME: orgName,
                      ADMIN_NAME: adminName,
                      EMPLOYEE_NAME: `${datas.first_name} ${datas.last_name}`,
                      LOGIN_EMAIL: datas.official_email,
                      TEMP_PASSWORD: tempPassword,
                      WEB_LOGIN_URL: process.env.WEB_LOGIN_URL ?? '',
                      IOS_APP_URL: process.env.IOS_APP_URL ?? '',
                      ANDROID_APP_URL: process.env.ANDROID_APP_URL ?? '',
                    },
                  });
                  await markEmployeeWelcomeEmailSent(trx, user_id);
                } catch (error) {
                  // eslint-disable-next-line no-console
                  console.error('Failed to send welcome email to employee:', error);
                }
              }
            }
          }
        }
      });

      const onboardingAfter = await UserOnboarding.query().findOne({ user_id });
      const justCompletedMobile =
        onboardingAfter?.onboarding_status === 'COMPLETED' &&
        existingBefore?.onboarding_status !== 'COMPLETED';

      if (justCompletedMobile && req.user?.org_id) {
        generateCurrentMonthPayrollForUser(user_id, req.user.org_id).catch((err) => {
          logger.error(
            { err, user_id, org_id: req.user.org_id },
            'Failed to generate current month payroll after mobile compliance completion',
          );
        });
      }

      if (req.user?.org_id) {
        triggerUserKycVerification(req.user.org_id, user_id).catch((err) => {
          logger.error(
            { err, user_id, org_id: req.user.org_id },
            'Failed to trigger KYC verification after mobile compliance update',
          );
        });

        syncAdminHrOnboardingComplianceForUserIfApplicable({
          userId: user_id,
          orgId: req.user.org_id,
          role: req.user.role,
          email: req.user.official_email,
        }).catch((err) => {
          logger.error(
            { err, user_id, org_id: req.user.org_id },
            'Failed to sync admin/hr compliance fields across orgs',
          );
        });
      }

      return res.status(200).json({
        message: 'Compliance and joining letter saved successfully',
        onboarding_status: onboardingAfter?.onboarding_status ?? null,
        ...(tempPassword ? { temp_password: tempPassword } : {}),
      });
    } catch {
      // console.error('Compliance Upsert Error:', error);
      return res.status(500).json({ message: 'Failed to submit compliance' });
    }
  }
  static async getOrganizationDocuments(req: Request, res: Response): Promise<Response> {
    const orgId = req.orgId;
    const userId = req.user?.id;

    const formatName = (str: string): string =>
      str
        ? str
            .split('_')
            .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ')
        : '';

    if (!orgId) {
      return res.status(400).json({ message: 'Organization ID is missing' });
    }

    try {
      const orgDocsRaw = (await OrganizationDocument.query()
        .where('org_id', orgId)
        .select('id', 'doc_type', 'file_url')) as any[];

      const organization_documents = orgDocsRaw.map((doc: any) => ({
        id: doc.id,
        type: doc.doc_type,
        name: formatName(doc.doc_type),
        url: doc.file_url,
      }));

      let user_documents: any[] = [];
      if (userId) {
        const userDocsRaw = (await UserDocument.query()
          .where('user_id', userId)
          .where('doc_category', 'LEGAL')
          .select('id', 'doc_type', 'file_url')) as any[];

        user_documents = userDocsRaw.map((doc: any) => ({
          id: doc.id,
          type: doc.doc_type,
          name: formatName(doc.doc_type),
          url: doc.file_url,
        }));
      }

      return res.status(200).json({
        message: 'Documents retrieved successfully',
        data: {
          organization_documents,
          user_documents,
        },
      });
    } catch (error) {
      logger.error({ err: error }, 'Error fetching documents');
      return res.status(500).json({
        message: 'Failed to fetch documents',
      });
    }
  }

  static async listInProgressUsers(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = onboardingInProgressUsersQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { page, limit, search, sort_dir } = parsed.data;
    const org_id = req.user.org_id;

    const baseQuery = User.query()
      .alias('u')
      .innerJoin('user_onboardings as uo', 'uo.user_id', 'u.id')
      .leftJoin('departments as d', 'd.id', 'u.department_id')
      .where('u.org_id', org_id)
      .where('uo.onboarding_status', 'IN_PROGRESS')
      .whereNull('u.deleted_at');

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
        'u.employee_id',
        'u.first_name',
        'u.last_name',
        'u.profile_image_url',
        'u.official_email',
        'u.role',
        'u.status',
        'u.department_id',
        'd.name as department_name',
        'uo.onboarding_status',
        'uo.kyc_status',
        'u.created_at',
      )
      .orderBy('u.created_at', sort_dir === 'ASC' ? 'asc' : 'desc')
      .limit(limit)
      .offset(offset);

    const data = rows.map((row: any) => ({
      id: row.id,
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
      onboarding_status: row.onboarding_status ?? null,
      kyc_status: row.kyc_status ?? null,
      created_at: row.created_at,
    }));

    return res.json({
      page: safePage,
      limit,
      total,
      total_pages,
      data,
    });
  }
}
