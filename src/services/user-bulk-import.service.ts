import * as XLSX from 'xlsx';

import { Department } from '../models/Department';
import { EmergencyContact } from '../models/EmergencyContact';
import { EmployeeEmploymentDetail } from '../models/EmployeeEmploymentDetail';
import { Organization } from '../models/Organization';
import { User } from '../models/User';
import { UserProfile } from '../models/UserProfile';
import { logger } from '../config/logger';
import { sendMsg91Email } from '../utils/msg91.utils';
import {
  hasEmployeeWelcomeEmailBeenSent,
  loadUserForWelcomeEmailLock,
  markEmployeeWelcomeEmailSent,
} from '../utils/employee-welcome-email.utils';
import {
  countOrganizationUsersTowardLimit,
  isRoleExcludedFromUserLimit,
  ORGANIZATION_USER_LIMIT_REACHED_MESSAGE,
} from '../utils/organization-user-limit.utils';
import { generateCurrentMonthPayrollForUser } from './auto-payroll.service';
import { applyEmployeePayrollFinanceUpdate } from './employee-payroll-finance.service';
import { createTenantUser, OrganizationUserLimitExceededError } from './tenant-user-create.service';
import {
  BULK_IMPORT_CANONICAL_HEADERS,
  BULK_IMPORT_MAX_ROWS,
  bulkImportUserRowSchema,
  buildFinancePayloadFromBulkRow,
  normalizeBulkImportHeader,
  rowHasEmergencyContact,
  rowHasPayroll,
  rowHasProfileFields,
  type BulkImportUserRow,
} from '../validators/tenant/user-bulk-import.validator';

export type BulkImportRowResultStatus = 'valid' | 'created' | 'failed';

export interface BulkImportRowResult {
  row: number;
  employee_id?: string;
  official_email?: string;
  status: BulkImportRowResultStatus;
  user_id?: string;
  error?: string;
}

export interface BulkImportSummary {
  total_rows: number;
  valid: number;
  created: number;
  failed: number;
  skipped: number;
}

export interface BulkImportOutcome {
  summary: BulkImportSummary;
  results: BulkImportRowResult[];
}

export class BulkImportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BulkImportParseError';
  }
}

interface ParsedRawRow {
  rowNumber: number;
  raw: Record<string, unknown>;
}

function isRowEmpty(raw: Record<string, unknown>): boolean {
  return Object.values(raw).every(
    (value) => value === undefined || value === null || String(value).trim() === '',
  );
}

function formatZodErrors(error: {
  flatten: () => { fieldErrors: Record<string, string[]> };
}): string {
  const fieldErrors = error.flatten().fieldErrors;
  const parts = Object.entries(fieldErrors).flatMap(([field, messages]) =>
    (messages ?? []).map((message) => `${field}: ${message}`),
  );
  return parts.join('; ') || 'Invalid row data';
}

export function parseBulkImportWorkbook(buffer: Buffer): ParsedRawRow[] {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new BulkImportParseError('Workbook has no sheets');
  }

  const worksheet = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
    header: 1,
    defval: '',
    raw: false,
  });

  if (matrix.length === 0) {
    throw new BulkImportParseError('Excel sheet is empty');
  }

  const headerRow = matrix[0] ?? [];
  const dataMatrix = matrix.slice(1);

  const headerMap = new Map<string, (typeof BULK_IMPORT_CANONICAL_HEADERS)[number]>();
  for (const headerCell of headerRow) {
    const canonical = normalizeBulkImportHeader(headerCell);
    if (canonical) {
      headerMap.set(String(headerCell).trim(), canonical);
    }
  }

  const mappedCanonical = new Set(headerMap.values());
  const requiredHeaders = [
    'employee_id',
    'first_name',
    'last_name',
    'role',
    'official_email',
  ] as const satisfies ReadonlyArray<(typeof BULK_IMPORT_CANONICAL_HEADERS)[number]>;
  const missingRequiredHeaders = requiredHeaders.filter((header) => !mappedCanonical.has(header));

  if (missingRequiredHeaders.length > 0) {
    throw new BulkImportParseError(
      `Missing required column headers: ${missingRequiredHeaders.join(', ')}`,
    );
  }

  const canonicalToSourceKey = new Map<(typeof BULK_IMPORT_CANONICAL_HEADERS)[number], number>();
  headerRow.forEach((headerCell, index) => {
    const canonical = normalizeBulkImportHeader(headerCell);
    if (canonical && !canonicalToSourceKey.has(canonical)) {
      canonicalToSourceKey.set(canonical, index);
    }
  });

  const parsedRows: ParsedRawRow[] = [];

  dataMatrix.forEach((rowValues, index) => {
    const normalized: Record<string, unknown> = {};
    for (const header of BULK_IMPORT_CANONICAL_HEADERS) {
      const columnIndex = canonicalToSourceKey.get(header);
      if (columnIndex === undefined) continue;
      const value = rowValues[columnIndex];
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        normalized[header] = value;
      }
    }

    if (isRowEmpty(normalized)) {
      return;
    }

    parsedRows.push({
      rowNumber: index + 2,
      raw: normalized,
    });
  });

  if (parsedRows.length === 0) {
    throw new BulkImportParseError('No data rows found in Excel sheet');
  }

  if (parsedRows.length > BULK_IMPORT_MAX_ROWS) {
    throw new BulkImportParseError(
      `Too many data rows (${parsedRows.length}). Maximum allowed is ${BULK_IMPORT_MAX_ROWS}.`,
    );
  }

  return parsedRows;
}

function normalizeRow(raw: ParsedRawRow): Record<string, unknown> {
  return {
    rowNumber: raw.rowNumber,
    ...raw.raw,
  };
}

async function sendWelcomeEmailForBulkUser(params: {
  userId: string;
  orgId: string;
  tempPassword: string;
  actorName: string;
}): Promise<void> {
  const { userId, orgId, tempPassword, actorName } = params;

  await User.transaction(async (trx) => {
    const lockedWelcome = await loadUserForWelcomeEmailLock(trx, userId);
    if (!lockedWelcome?.official_email) return;
    if (hasEmployeeWelcomeEmailBeenSent(lockedWelcome)) return;

    const organization = await Organization.query(trx).findById(orgId);
    const orgName = organization?.name ?? 'Your Organization';
    const employeeName =
      `${lockedWelcome.first_name ?? ''} ${lockedWelcome.last_name ?? ''}`.trim() || 'User';

    await sendMsg91Email({
      toEmail: lockedWelcome.official_email,
      toName: employeeName,
      templateId: 'employee_welcome_email',
      variables: {
        ORG_NAME: orgName,
        ADMIN_NAME: actorName,
        EMPLOYEE_NAME: employeeName,
        LOGIN_EMAIL: lockedWelcome.official_email,
        TEMP_PASSWORD: tempPassword,
        WEB_LOGIN_URL: process.env.WEB_LOGIN_URL ?? '',
        IOS_APP_URL: process.env.IOS_APP_URL ?? '',
        ANDROID_APP_URL: process.env.ANDROID_APP_URL ?? '',
      },
    });

    await markEmployeeWelcomeEmailSent(trx, userId);
  });
}

async function resolveBulkImportDepartmentId(
  orgId: string,
  row: BulkImportUserRow,
): Promise<{ department_id?: string; error?: string }> {
  if (row.department_name) {
    const dept = await Department.query()
      .where({ org_id: orgId })
      .whereNull('deleted_at')
      .whereRaw('LOWER(name) = ?', [row.department_name.trim().toLowerCase()])
      .first();
    if (!dept) return { error: 'Invalid department_name' };
    if (row.department_id && row.department_id !== dept.id) {
      return { error: 'department_name and department_id do not match' };
    }
    return { department_id: dept.id };
  }
  if (row.department_id) {
    const dept = await Department.query().findOne({ id: row.department_id, org_id: orgId });
    if (!dept) return { error: 'Invalid department_id' };
    return { department_id: row.department_id };
  }
  return {};
}

async function importSingleRow(params: {
  row: BulkImportUserRow;
  orgId: string;
  actorUserId: string;
  actorName: string;
  department_id?: string;
}): Promise<BulkImportRowResult> {
  const { row, orgId, actorName, department_id } = params;
  const baseResult: BulkImportRowResult = {
    row: row.rowNumber,
    employee_id: row.employee_id,
    official_email: row.official_email,
    status: 'failed',
  };

  try {
    let tempPassword: string | null = null;
    let passwordReused = false;
    let onboardingDataCloned = false;

    const createdUser = await User.transaction(async (trx) => {
      const result = await createTenantUser({
        org_id: orgId,
        employee_id: row.employee_id,
        first_name: row.first_name,
        last_name: row.last_name,
        official_email: row.official_email,
        role: row.role,
        department_id,
        designation: row.designation,
        date_of_joining: row.date_of_joining,
        trx,
      });

      tempPassword = result.tempPassword;
      passwordReused = result.passwordReused;
      onboardingDataCloned = result.onboardingDataCloned;
      const user = result.user;

      // When person data was cloned from another org, skip CSV profile/emergency inserts.
      if (!onboardingDataCloned && rowHasProfileFields(row)) {
        await UserProfile.query(trx).insert({
          user_id: user.id,
          personal_phone: row.phone_number,
          alt_phone: row.alt_phone,
          gender: row.gender,
          dob: row.dob,
          personal_email: row.personal_email,
          blood_group: row.blood_group,
          marital_status: row.marital_status,
          nationality: row.nationality,
        });
      }

      if (!onboardingDataCloned && rowHasEmergencyContact(row)) {
        await EmergencyContact.query(trx).insert({
          user_id: user.id,
          name: row.emergency_contact_name!,
          phone: row.emergency_contact_phone!,
          relation: row.emergency_contact_relation!,
          is_primary: true,
        });
      }

      const hasEmploymentFields =
        row.employment_type !== undefined ||
        row.work_mode !== undefined ||
        row.shift_mode !== undefined;

      if (hasEmploymentFields) {
        await EmployeeEmploymentDetail.query(trx)
          .insert({
            user_id: user.id,
            employment_type: row.employment_type,
            work_mode: row.work_mode,
            notes: row.shift_mode,
          })
          .onConflict('user_id')
          .merge({
            employment_type: row.employment_type,
            work_mode: row.work_mode,
            notes: row.shift_mode,
          });
      }

      return user;
    });

    if (rowHasPayroll(row)) {
      await applyEmployeePayrollFinanceUpdate({
        userId: createdUser.id,
        org_id: orgId,
        finance: buildFinancePayloadFromBulkRow(row),
        effective_from: new Date(),
        sync_current_month: false,
      });

      generateCurrentMonthPayrollForUser(createdUser.id, orgId).catch((err) => {
        logger.error(
          { err, user_id: createdUser.id, org_id: orgId },
          'Failed to auto-generate current month payroll after bulk import',
        );
      });
    } else {
      generateCurrentMonthPayrollForUser(createdUser.id, orgId).catch((err) => {
        logger.error(
          { err, user_id: createdUser.id, org_id: orgId },
          'Failed to auto-generate current month payroll after bulk import user create',
        );
      });
    }

    if (row.send_welcome_email && !passwordReused && tempPassword) {
      try {
        await sendWelcomeEmailForBulkUser({
          userId: createdUser.id,
          orgId,
          tempPassword,
          actorName,
        });
      } catch (err) {
        logger.error(
          { err, user_id: createdUser.id, org_id: orgId },
          'Bulk import: failed to send welcome email',
        );
      }
    }

    return {
      ...baseResult,
      status: 'created',
      user_id: createdUser.id,
    };
  } catch (error) {
    if (error instanceof OrganizationUserLimitExceededError) {
      return { ...baseResult, error: error.message };
    }

    const message = error instanceof Error ? error.message : 'Failed to create user';
    return { ...baseResult, error: message };
  }
}

export async function validateBulkImportRows(
  parsedRows: ParsedRawRow[],
  orgId: string,
): Promise<BulkImportOutcome> {
  const results: BulkImportRowResult[] = [];
  const seenEmployeeIds = new Map<string, number>();
  const seenEmails = new Map<string, number>();
  const seenPersonalEmails = new Map<string, number>();

  const org = await Organization.query().findById(orgId);
  const currentUserCount = await countOrganizationUsersTowardLimit(orgId);
  const maxUsers = org?.max_users ?? 50;

  let pendingNonAdminCreates = 0;

  for (const parsed of parsedRows) {
    const normalized = normalizeRow(parsed);
    const zodResult = bulkImportUserRowSchema.safeParse(normalized);

    if (!zodResult.success) {
      results.push({
        row: parsed.rowNumber,
        employee_id: String(normalized.employee_id ?? ''),
        official_email: String(normalized.official_email ?? ''),
        status: 'failed',
        error: formatZodErrors(zodResult.error),
      });
      continue;
    }

    const row = zodResult.data;
    const employeeKey = row.employee_id.trim().toLowerCase();
    const emailKey = row.official_email.trim().toLowerCase();

    if (seenEmployeeIds.has(employeeKey)) {
      results.push({
        row: row.rowNumber,
        employee_id: row.employee_id,
        official_email: row.official_email,
        status: 'failed',
        error: `Duplicate employee_id in file (also on row ${seenEmployeeIds.get(employeeKey)})`,
      });
      continue;
    }

    if (seenEmails.has(emailKey)) {
      results.push({
        row: row.rowNumber,
        employee_id: row.employee_id,
        official_email: row.official_email,
        status: 'failed',
        error: `Duplicate official_email in file (also on row ${seenEmails.get(emailKey)})`,
      });
      continue;
    }

    seenEmployeeIds.set(employeeKey, row.rowNumber);
    seenEmails.set(emailKey, row.rowNumber);

    if (row.personal_email) {
      const personalEmailKey = row.personal_email.trim().toLowerCase();
      if (seenPersonalEmails.has(personalEmailKey)) {
        results.push({
          row: row.rowNumber,
          employee_id: row.employee_id,
          official_email: row.official_email,
          status: 'failed',
          error: `Duplicate personal_email in file (also on row ${seenPersonalEmails.get(personalEmailKey)})`,
        });
        continue;
      }
      seenPersonalEmails.set(personalEmailKey, row.rowNumber);

      const existingPersonalEmail = await UserProfile.query()
        .alias('up')
        .innerJoin('users as u', 'u.id', 'up.user_id')
        .where('u.org_id', orgId)
        .whereNull('u.deleted_at')
        .whereRaw('LOWER(up.personal_email) = ?', [personalEmailKey])
        .select('up.user_id')
        .first();

      if (existingPersonalEmail) {
        results.push({
          row: row.rowNumber,
          employee_id: row.employee_id,
          official_email: row.official_email,
          status: 'failed',
          error: 'personal_email already exists',
        });
        continue;
      }
    }

    const departmentResolution = await resolveBulkImportDepartmentId(orgId, row);
    if (departmentResolution.error) {
      results.push({
        row: row.rowNumber,
        employee_id: row.employee_id,
        official_email: row.official_email,
        status: 'failed',
        error: departmentResolution.error,
      });
      continue;
    }

    const existingEmail = await User.query().findOne({
      org_id: orgId,
      official_email: row.official_email,
    });
    if (existingEmail) {
      results.push({
        row: row.rowNumber,
        employee_id: row.employee_id,
        official_email: row.official_email,
        status: 'failed',
        error: 'Email already exists',
      });
      continue;
    }

    const existingEmployeeId = await User.query().findOne({
      org_id: orgId,
      employee_id: row.employee_id,
    });
    if (existingEmployeeId) {
      results.push({
        row: row.rowNumber,
        employee_id: row.employee_id,
        official_email: row.official_email,
        status: 'failed',
        error: 'employee_id already exists',
      });
      continue;
    }

    if (!isRoleExcludedFromUserLimit(row.role)) {
      pendingNonAdminCreates += 1;
      if (currentUserCount + pendingNonAdminCreates > maxUsers) {
        results.push({
          row: row.rowNumber,
          employee_id: row.employee_id,
          official_email: row.official_email,
          status: 'failed',
          error: ORGANIZATION_USER_LIMIT_REACHED_MESSAGE,
        });
        continue;
      }
    }

    results.push({
      row: row.rowNumber,
      employee_id: row.employee_id,
      official_email: row.official_email,
      status: 'valid',
    });
  }

  return buildOutcome(results, true);
}

export async function importBulkUsers(params: {
  parsedRows: ParsedRawRow[];
  orgId: string;
  actorUserId: string;
  actorName: string;
}): Promise<BulkImportOutcome> {
  const validation = await validateBulkImportRows(params.parsedRows, params.orgId);
  const results: BulkImportRowResult[] = [];
  let limitReached = false;
  const createdEmployeeIds = new Set<string>();
  const createdEmails = new Set<string>();
  const createdPersonalEmails = new Set<string>();

  for (const parsed of params.parsedRows) {
    const prior = validation.results.find((r) => r.row === parsed.rowNumber);

    if (!prior || prior.status === 'failed') {
      results.push(
        prior ?? {
          row: parsed.rowNumber,
          status: 'failed',
          error: 'Row failed validation',
        },
      );
      continue;
    }

    if (limitReached) {
      results.push({
        row: parsed.rowNumber,
        employee_id: prior.employee_id,
        official_email: prior.official_email,
        status: 'failed',
        error: ORGANIZATION_USER_LIMIT_REACHED_MESSAGE,
      });
      continue;
    }

    const normalized = normalizeRow(parsed);
    const zodResult = bulkImportUserRowSchema.safeParse(normalized);
    if (!zodResult.success) {
      results.push({
        row: parsed.rowNumber,
        employee_id: prior.employee_id,
        official_email: prior.official_email,
        status: 'failed',
        error: formatZodErrors(zodResult.error),
      });
      continue;
    }

    const row = zodResult.data;
    const employeeKey = row.employee_id.trim().toLowerCase();
    const emailKey = row.official_email.trim().toLowerCase();

    if (createdEmployeeIds.has(employeeKey)) {
      results.push({
        row: row.rowNumber,
        employee_id: row.employee_id,
        official_email: row.official_email,
        status: 'failed',
        error: 'employee_id already created earlier in this import',
      });
      continue;
    }

    if (createdEmails.has(emailKey)) {
      results.push({
        row: row.rowNumber,
        employee_id: row.employee_id,
        official_email: row.official_email,
        status: 'failed',
        error: 'official_email already created earlier in this import',
      });
      continue;
    }

    if (row.personal_email) {
      const personalEmailKey = row.personal_email.trim().toLowerCase();
      if (createdPersonalEmails.has(personalEmailKey)) {
        results.push({
          row: row.rowNumber,
          employee_id: row.employee_id,
          official_email: row.official_email,
          status: 'failed',
          error: 'personal_email already created earlier in this import',
        });
        continue;
      }
    }

    const departmentResolution = await resolveBulkImportDepartmentId(params.orgId, row);
    if (departmentResolution.error) {
      results.push({
        row: row.rowNumber,
        employee_id: row.employee_id,
        official_email: row.official_email,
        status: 'failed',
        error: departmentResolution.error,
      });
      continue;
    }

    const importResult = await importSingleRow({
      row,
      orgId: params.orgId,
      actorUserId: params.actorUserId,
      actorName: params.actorName,
      department_id: departmentResolution.department_id,
    });

    if (importResult.status === 'created') {
      createdEmployeeIds.add(employeeKey);
      createdEmails.add(emailKey);
      if (row.personal_email) {
        createdPersonalEmails.add(row.personal_email.trim().toLowerCase());
      }
    }

    if (
      importResult.status === 'failed' &&
      importResult.error === ORGANIZATION_USER_LIMIT_REACHED_MESSAGE
    ) {
      limitReached = true;
    }

    results.push(importResult);
  }

  return buildOutcome(results, false);
}

function buildOutcome(results: BulkImportRowResult[], dryRun: boolean): BulkImportOutcome {
  const failed = results.filter((r) => r.status === 'failed').length;
  const created = dryRun
    ? results.filter((r) => r.status === 'valid').length
    : results.filter((r) => r.status === 'created').length;

  return {
    summary: {
      total_rows: results.length,
      valid: results.length - failed,
      created,
      failed,
      skipped: 0,
    },
    results,
  };
}

export function parseAndPrepareBulkImport(buffer: Buffer): ParsedRawRow[] {
  return parseBulkImportWorkbook(buffer);
}
