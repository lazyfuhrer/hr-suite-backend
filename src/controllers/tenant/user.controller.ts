import type { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { Department } from '../../models/Department';
import { User } from '../../models/User';
import { RefreshToken } from '../../models/RefreshToken';
import { PasswordResetToken } from '../../models/PasswordResetToken';
import { UserProfile } from '../../models/UserProfile';
import { EmergencyContact } from '../../models/EmergencyContact';
import { EmployeeEmploymentDetail } from '../../models/EmployeeEmploymentDetail';
import { Address } from '../../models/Address';
import { UserDocument } from '../../models/UserDocument';
import {
  userDocumentListQuerySchema,
  employeeLeavesQuerySchema,
  employeePayrollsQuerySchema,
} from '../../validators';
import { LeaveRequest } from '../../models/LeaveRequest';
import { LeaveType } from '../../models/LeaveType';
import { AttendanceLog } from '../../models/AttendanceLog';
import { AttendanceBreak } from '../../models/AttendanceBreak';
import { BankDetail } from '../../models/BankDetail';
import { UserPayrollDetail } from '../../models/UserPayrollDetail';
import { PayrollRecord } from '../../models/PayrollRecord';
import { SalaryComponent } from '../../models/SalaryComponent';
import { SalaryStructure } from '../../models/SalaryStructure';
import {
  applyDaySessionFactor,
  calculateEffectiveQuota,
  countLeaveDaysInRange,
  resolveLeaveScheduleForRow,
} from '../../utils/leave.utils';
import { generateTempPassword } from '../../utils/password.util';
import {
  createUserSchema,
  sendTemporaryPasswordSchema,
  createDeviceUserSchema,
  userListQuerySchema,
  userExcelDownloadQuerySchema,
  upcomingBirthdaysQuerySchema,
  userUnassignedQuerySchema,
  updatePersonalInfoSchema,
  editEmployeePayrollFinanceSchema,
  updateUserByAdminSchema,
  bulkImportQuerySchema,
} from '../../validators';
import { Roles } from '../../models/Roles';
import { UserRole } from '../../models/UserRoles';
import { ORG_USER_ROLES, type OrgUserRole } from '../../constants/user-roles';
import {
  ATTENDANCE_ACTIVE_EMPLOYEE_STATUSES,
  REAL_EMPLOYEE_STATUSES,
} from '../../constants/user-status';
import { UserExit } from '../../models/UserExit';
import { logger } from '../../config/logger';
import {
  fetchPrimaryManagedDepartmentScheduleByManagerIds,
  getManagedDepartmentIds,
} from '../../utils/department-manager.utils';
import {
  applyResignedUsersInPeriodFilter,
  findActiveExit,
  formatExitForProfile,
} from '../../utils/user-exit.utils';
import {
  applyExcludeInProgressOnboardingFilter,
  isKycFlowEnabledForOrg,
} from '../../utils/user-visibility.utils';
import {
  generateUserDetailsExcelBuffer,
  userDetailsExcelFileName,
  type UserDetailsExcelRow,
} from '../../utils/user-details-excel.utils';
import { getTodayDate, normalizeDate } from '../../utils/date.utils';
import { invalidateTenantSessionsForUsers } from '../../utils/session-invalidation.utils';
import {
  payrollRecordToPayslipPayPeriodInput,
  resolvePayrollListDisplayAmountsBatch,
} from '../../utils/payroll-list-display.utils';
import { DepartmentManager } from '../../models/DepartmentManager';
import { knex } from '../../config/database';
import { randomUUID } from 'crypto';
import { env } from '../../config/env';
import { indexUserFaceFromS3 } from '../../services/face-recognition.service';
import { buildS3PublicUrl, getS3Client } from '../../utils/s3';
import {
  fetchEffectiveHolidayDateSet,
  resolveEffectiveAttendanceSchedule,
  shouldOmitAttendanceCalendarDate,
} from '../../utils/attendance-schedule.utils';
import { generateCurrentMonthPayrollForUser } from '../../services/auto-payroll.service';
import { applyEmployeePayrollFinanceUpdate } from '../../services/employee-payroll-finance.service';
import {
  createTenantUser,
  OrganizationUserLimitExceededError,
} from '../../services/tenant-user-create.service';
import {
  BulkImportParseError,
  importBulkUsers,
  parseAndPrepareBulkImport,
  validateBulkImportRows,
} from '../../services/user-bulk-import.service';
import {
  BULK_IMPORT_TEMPLATE_FILENAME,
  buildBulkImportTemplateBuffer,
} from '../../utils/user-bulk-import-template.utils';
import { Organization } from '../../models/Organization';
import { sendMsg91Email } from '../../utils/msg91.utils';
import {
  hasEmployeeWelcomeEmailBeenSent,
  loadUserForWelcomeEmailLock,
  markEmployeeWelcomeEmailSent,
} from '../../utils/employee-welcome-email.utils';
import { assertOrganizationUserLimit } from '../../utils/organization-user-limit.utils';
import {
  isAdminOrHrRole,
  syncAdminHrPasswordByEmail,
} from '../../utils/cross-org-admin-hr-password.utils';
import {
  AdminHrCrossOrgConflictError,
  AdminHrCrossOrgEligibilityError,
  AdminHrCrossOrgNotFoundError,
  ensureAndCloneAdminHrFromEmail,
  syncAdminHrFullForUserIfApplicable,
} from '../../services/cross-org-admin-hr-onboarding-clone.service';

export class UserController {
  private static sanitizeMoney(input: number): number {
    if (!Number.isFinite(input)) return 0;
    return Math.round(input * 100) / 100;
  }

  static async createDevice(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. Insufficient permissions.' });
    }

    const parsed = createDeviceUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const org_id = req.user.org_id;
    const { name, email, employeeId, password } = parsed.data;

    const generatedEmployeeId = `DEV-${randomUUID().slice(0, 8).toUpperCase()}`;
    const finalEmployeeId = employeeId ?? generatedEmployeeId;

    const generatedEmail = `device+${org_id.slice(0, 8)}+${randomUUID().slice(0, 8)}@devices.hr-suite.local`;
    const finalEmail = email ?? generatedEmail;

    const existingEmail = await User.query().findOne({ org_id, official_email: finalEmail });
    if (existingEmail) {
      return res.status(409).json({ message: 'Email already exists' });
    }

    const existingEmployeeId = await User.query().findOne({ org_id, employee_id: finalEmployeeId });
    if (existingEmployeeId) {
      return res.status(409).json({ message: 'employeeId already exists' });
    }

    const devicePassword = password ?? generateTempPassword();
    const password_hash = await bcrypt.hash(devicePassword, 10);

    let createdUser: User;
    try {
      createdUser = await User.transaction(async (trx) => {
        const roleRecord = await Roles.query(trx).where('name', 'device').first();
        if (!roleRecord) {
          throw new Error('Role "device" not found in the database.');
        }

        await assertOrganizationUserLimit(org_id, roleRecord.name, trx);

        const created = await User.query(trx).insert({
          org_id,
          employee_id: finalEmployeeId,
          first_name: name,
          last_name: '',
          official_email: finalEmail,
          password_hash,
          role: roleRecord.name,
          status: 'ACTIVE',
          must_change_password: true,
        });

        await UserRole.query(trx).insert({
          role_id: roleRecord.id,
          user_id: created.id,
        });

        return created;
      });
    } catch (error) {
      if (error instanceof OrganizationUserLimitExceededError) {
        return res.status(403).json({ message: error.message });
      }
      throw error;
    }

    // Best-effort welcome email with temp password (only when explicit email was provided).
    if (email && createdUser.official_email) {
      try {
        await User.transaction(async (trx) => {
          const lockedWelcome = await loadUserForWelcomeEmailLock(trx, createdUser.id);
          if (!lockedWelcome?.official_email) return;
          if (hasEmployeeWelcomeEmailBeenSent(lockedWelcome)) return;

          const organization = await Organization.query(trx).findById(org_id);
          const orgName = organization?.name ?? 'Your Organization';
          const adminName =
            (req.user?.first_name || req.user?.last_name
              ? `${req.user?.first_name ?? ''} ${req.user?.last_name ?? ''}`.trim()
              : 'Admin') || 'Admin';
          const deviceName =
            `${lockedWelcome.first_name ?? ''} ${lockedWelcome.last_name ?? ''}`.trim();

          await sendMsg91Email({
            toEmail: lockedWelcome.official_email,
            toName: deviceName || 'User',
            templateId: 'employee_welcome_email',
            variables: {
              ORG_NAME: orgName,
              ADMIN_NAME: adminName,
              EMPLOYEE_NAME: deviceName || 'User',
              LOGIN_EMAIL: lockedWelcome.official_email,
              TEMP_PASSWORD: devicePassword,
              WEB_LOGIN_URL: process.env.WEB_LOGIN_URL ?? '',
              IOS_APP_URL: process.env.IOS_APP_URL ?? '',
              ANDROID_APP_URL: process.env.ANDROID_APP_URL ?? '',
            },
          });

          await markEmployeeWelcomeEmailSent(trx, createdUser.id);
        });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to send device-user welcome email:', error);
      }
    }

    generateCurrentMonthPayrollForUser(createdUser.id, org_id).catch((err) => {
      logger.error(
        { err, user_id: createdUser.id, org_id },
        'Failed to auto-generate current month payroll after user create',
      );
    });

    return res.status(201).json({
      id: createdUser.id,
      org_id: createdUser.org_id,
      employee_id: createdUser.employee_id,
      name: createdUser.first_name,
      official_email: createdUser.official_email,
      role: createdUser.role,
      status: createdUser.status,
      device_password: devicePassword,
    });
  }

  static async listDevices(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. Insufficient permissions.' });
    }

    const org_id = req.user.org_id;

    const devices = await User.query()
      .where('org_id', org_id)
      .where('role', 'device')
      .whereNull('deleted_at')
      .select('id', 'employee_id', 'first_name', 'official_email', 'status', 'created_at');

    const items = devices.map((d) => ({
      id: d.id,
      employee_id: d.employee_id,
      name: d.first_name,
      official_email: d.official_email,
      status: d.status,
      created_at: d.created_at,
    }));

    return res.json({ items });
  }

  /**
   * Re-index a user's face from their passport-size photo.
   * - Multipart field `image` (optional): upload JPG/PNG to S3, replace any PASSPORT_SIZE_PHOTO
   *   `user_documents` rows for this user, then reindex from the new object.
   * - No file: reindex from the latest stored PASSPORT_SIZE_PHOTO (same as before).
   * Admin only.
   */
  static async reindexFace(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. Admin only.' });
    }

    const org_id = req.user.org_id;
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({ message: 'userId is required' });
    }

    const user = await User.query().where({ id: userId, org_id }).whereNull('deleted_at').first();
    if (!user) {
      return res.status(404).json({ message: 'User not found in this organization' });
    }

    let fileKey: string;

    const file = req.file;
    if (file) {
      if (!env.S3_BUCKET) {
        return res.status(503).json({ message: 'S3 bucket not configured' });
      }
      const allowed = new Set(['image/jpeg', 'image/png']);
      if (!allowed.has(file.mimetype)) {
        return res.status(400).json({
          message: 'Passport photo must be JPG or PNG for face reindex.',
        });
      }

      const sanitizeFilename = (name: string): string =>
        name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
      const safeName = sanitizeFilename(file.originalname || 'photo.jpg');
      const key = [
        'orgs',
        org_id,
        'users',
        userId,
        'documents',
        'IDENTITY',
        'PASSPORT_SIZE_PHOTO',
        `${randomUUID()}-${safeName}`,
      ].join('/');

      const client = getS3Client();
      await client.send(
        new PutObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype,
        }),
      );

      const file_url = buildS3PublicUrl(key);
      const trx = await UserDocument.startTransaction();
      try {
        await UserDocument.query(trx)
          .delete()
          .where({ user_id: userId })
          .where('doc_type', 'PASSPORT_SIZE_PHOTO');
        await UserDocument.query(trx).insert({
          user_id: userId,
          doc_category: 'IDENTITY',
          doc_type: 'PASSPORT_SIZE_PHOTO',
          file_url,
          file_key: key,
          uploaded_by: req.user.id,
        });
        await trx.commit();
      } catch (err) {
        await trx.rollback();
        throw err;
      }

      fileKey = key;
    } else {
      const passportDoc = await UserDocument.query()
        .where({ user_id: userId })
        .where('doc_type', 'PASSPORT_SIZE_PHOTO')
        .whereNotNull('file_key')
        .orderBy('created_at', 'desc')
        .first();

      if (!passportDoc?.file_key) {
        return res.status(404).json({
          message:
            'No passport-size photo document with file_key found for this user. Upload one first (e.g. send multipart field `image`).',
        });
      }

      fileKey = passportDoc.file_key;
    }

    if (!env.S3_BUCKET) {
      return res.status(503).json({ message: 'S3 bucket not configured' });
    }

    try {
      await indexUserFaceFromS3(org_id, userId, env.S3_BUCKET, fileKey, {
        rethrow: true,
      });
    } catch (error: any) {
      if (error?.name === 'InvalidImageFormatException') {
        return res.status(400).json({
          message:
            'Passport photo format is not supported by Rekognition. Upload a JPG or PNG passport-size photo and retry.',
        });
      }

      return res.status(502).json({
        message: 'Failed to re-index face due to face service error. Please try again.',
      });
    }

    const row = await knex('user_face_embeddings').where({ org_id, user_id: userId }).first();
    if (!row) {
      logger.warn(
        { userId, org_id },
        'Reindex face: no row created (no face in photo or Rekognition/S3 issue)',
      );
      return res.status(500).json({
        message:
          'Re-index did not create a face record. Ensure the passport photo contains a clear face and Rekognition is configured.',
      });
    }

    return res.json({
      message: 'Face re-indexed successfully. User can use face-clock now.',
      user_id: userId,
    });
  }

  static async create(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { email, firstName, lastName, role, departmentId, employeeId } = parsed.data;

    const org_id = req.user.org_id;

    if (departmentId) {
      const department = await Department.query().findOne({ id: departmentId, org_id });
      if (!department) {
        return res.status(400).json({ message: 'Invalid departmentId' });
      }
    }

    const existingEmail = await User.query().findOne({ org_id, official_email: email });
    if (existingEmail) {
      return res.status(409).json({ message: 'Email already exists' });
    }

    const existingEmployeeId = await User.query().findOne({ org_id, employee_id: employeeId });
    if (existingEmployeeId) {
      return res.status(409).json({ message: 'employeeId already exists' });
    }

    let createdUser: User;
    let tempPassword: string | null;
    let passwordReused = false;
    let onboardingDataCloned = false;
    try {
      const result = await createTenantUser({
        org_id,
        employee_id: employeeId,
        first_name: firstName,
        last_name: lastName,
        official_email: email,
        role,
        department_id: departmentId,
      });
      createdUser = result.user;
      tempPassword = result.tempPassword;
      passwordReused = result.passwordReused;
      onboardingDataCloned = result.onboardingDataCloned;
    } catch (error) {
      if (error instanceof OrganizationUserLimitExceededError) {
        return res.status(403).json({ message: error.message });
      }
      throw error;
    }

    generateCurrentMonthPayrollForUser(createdUser.id, org_id).catch((err) => {
      logger.error(
        { err, user_id: createdUser.id, org_id },
        'Failed to auto-generate current month payroll after user create',
      );
    });

    return res.status(201).json({
      id: createdUser.id,
      org_id: createdUser.org_id,
      employee_id: createdUser.employee_id,
      first_name: createdUser.first_name,
      last_name: createdUser.last_name,
      official_email: createdUser.official_email,
      role: createdUser.role,
      status: createdUser.status,
      department_id: createdUser.department_id,
      password_reused: passwordReused,
      onboarding_data_cloned: onboardingDataCloned,
      ...(passwordReused || !tempPassword ? {} : { temp_password: tempPassword }),
    });
  }

  /**
   * Builds the filtered/scoped user query shared by the paginated list endpoint
   * and the Excel export. Joins `departments`, the primary managed department
   * subquery, employment details and onboarding; callers add their own selects.
   *
   * The builder is returned wrapped in an object because an objection query
   * builder is thenable and would otherwise be executed by the `await`.
   */
  private static async buildUserListBaseQuery(opts: {
    org_id: string;
    isManager: boolean;
    managedDepartmentIds: string[];
    kycFlowEnabled: boolean;
    filters: {
      role?: OrgUserRole;
      filterDepartmentId?: string;
      status?: string;
      search?: string;
      hasPeriodFilter: boolean;
      periodStart: string;
      periodEnd: string;
    };
  }) {
    const { org_id, isManager, managedDepartmentIds, kycFlowEnabled, filters } = opts;
    const { role, filterDepartmentId, status, search, hasPeriodFilter, periodStart, periodEnd } =
      filters;

    // Subquery to get the first department for each manager using window function
    const managerDeptSubquery = knex
      .select('manager_id', 'department_id', 'department_name')
      .from(
        knex
          .select(
            'dm.manager_id',
            'dm.department_id',
            'd.name as department_name',
            knex.raw(
              'ROW_NUMBER() OVER (PARTITION BY dm.manager_id ORDER BY dm.created_at ASC) as rn',
            ),
          )
          .from('department_managers as dm')
          .innerJoin('departments as d', 'd.id', 'dm.department_id')
          .where('d.org_id', org_id)
          .whereNull('d.deleted_at')
          .as('ranked'),
      )
      .where('rn', 1)
      .as('manager_dept');

    const baseQuery = User.query()
      .alias('users')
      .leftJoin('departments', 'departments.id', 'users.department_id')
      .leftJoin(managerDeptSubquery, 'manager_dept.manager_id', 'users.id')
      .leftJoin('employee_employment_details as eed', 'eed.user_id', 'users.id')
      .leftJoin('user_onboardings as uo', 'uo.user_id', 'users.id')
      .where('users.org_id', org_id)
      .whereIn('users.role', ORG_USER_ROLES)
      .whereIn('users.status', REAL_EMPLOYEE_STATUSES as readonly string[])
      .whereNull('users.deleted_at');
    if (kycFlowEnabled) {
      applyExcludeInProgressOnboardingFilter(baseQuery, 'users');
    }

    if (isManager) {
      if (managedDepartmentIds.length === 0) {
        baseQuery.whereRaw('1 = 0');
      } else {
        // Managers: include employees/HR in managed departments AND managers assigned to those departments
        const managerSubquery = DepartmentManager.query()
          .alias('dm')
          .whereIn('dm.department_id', managedDepartmentIds)
          .select('dm.manager_id');

        baseQuery.where((b) => {
          b.whereIn('users.department_id', managedDepartmentIds)
            .whereIn('users.role', ['employee', 'hr'])
            .orWhereIn('users.id', managerSubquery);
        });
      }
    }

    // --- FILTERS ---
    if (role) baseQuery.where('users.role', role);
    if (filterDepartmentId) {
      // Filter by department: include users with direct department_id OR managers assigned via department_managers
      const managerRowsInDept = await knex
        .select('dm.manager_id')
        .from('department_managers as dm')
        .where('dm.department_id', filterDepartmentId);

      const managerIdsInDept = managerRowsInDept.map((row: any) => row.manager_id);

      baseQuery.where((b) => {
        b.where('users.department_id', filterDepartmentId);
        if (managerIdsInDept.length > 0) {
          b.orWhereIn('users.id', managerIdsInDept);
        }
      });
    }
    if (hasPeriodFilter) {
      baseQuery.whereRaw(
        'COALESCE(users.date_of_joining::date, users.created_at::date) BETWEEN ?::date AND ?::date',
        [periodStart, periodEnd],
      );
    }

    // Handle "ALL" status bypass
    if (status && status !== 'ALL') {
      baseQuery.where('users.status', status);
    }

    // Fix: Only apply search if it exists (schema transform handles empty string)
    if (search) {
      const term = `%${search}%`;
      baseQuery.where((b) => {
        b.where('users.employee_id', 'ilike', term)
          .orWhere('users.first_name', 'ilike', term)
          .orWhere('users.last_name', 'ilike', term)
          .orWhere('users.official_email', 'ilike', term)
          .orWhereRaw("concat(users.first_name, ' ', users.last_name) ilike ?", [term]);
      });
    }

    return { baseQuery };
  }

  private static applyUserListSort(query: any, sortBy?: string): void {
    switch (sortBy) {
      case 'joinDate':
        query.orderBy('users.date_of_joining', 'desc'); // Newest first
        break;
      case 'department':
        query.orderBy('departments.name', 'asc');
        break;
      case 'status':
        query.orderBy('users.status', 'asc');
        break;
      case 'name':
      default:
        query.orderBy('users.first_name', 'asc');
        break;
    }

    // Ensure consistent secondary sort
    query.orderBy('users.created_at', 'desc');
  }

  static async list(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // 1. Validate Query
    const parsed = userListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const org_id = req.user.org_id;
    const isManager = req.user.role === 'manager';
    const kycFlowEnabled = await isKycFlowEnabledForOrg(org_id);

    let managedDepartmentIds: string[] = [];
    if (isManager) {
      managedDepartmentIds = await getManagedDepartmentIds(org_id, req.user.id);
    }

    // 2. Destructure new 'sortBy' param
    const {
      page,
      limit,
      role,
      month,
      year,
      department_id,
      department,
      status,
      search,
      view,
      sortBy,
    } = parsed.data;

    // Use 'department' parameter if provided, otherwise fall back to 'department_id'
    const filterDepartmentId = department || department_id;
    const hasPeriodFilter = month !== undefined || year !== undefined;
    const now = new Date();
    const effectiveYear = year ?? now.getUTCFullYear();
    const effectiveMonth = month ?? now.getUTCMonth() + 1;
    const periodStart = new Date(Date.UTC(effectiveYear, effectiveMonth - 1, 1))
      .toISOString()
      .slice(0, 10);
    const periodEnd = new Date(Date.UTC(effectiveYear, effectiveMonth, 0))
      .toISOString()
      .slice(0, 10);

    const wantsList = view === 'list' || view === 'both';
    const wantsStatistics = view === 'statistics' || view === 'both';

    let listPayload: any = null;

    if (wantsList) {
      const { baseQuery } = await UserController.buildUserListBaseQuery({
        org_id,
        isManager,
        managedDepartmentIds,
        kycFlowEnabled,
        filters: {
          role,
          filterDepartmentId,
          status,
          search,
          hasPeriodFilter,
          periodStart,
          periodEnd,
        },
      });

      // --- PAGINATION STATS ---
      const totalRow = await baseQuery.clone().countDistinct('users.id as count').first();
      const total = Number((totalRow as unknown as { count?: string | number })?.count ?? 0);
      const total_pages = Math.max(1, Math.ceil(total / limit));
      const safePage = Math.min(Math.max(page, 1), total_pages);
      const offset = (safePage - 1) * limit;

      // --- SORTING LOGIC ---
      // Clone query for data fetching
      const dataQuery = baseQuery
        .clone()
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
          'departments.name as department_name',
          'manager_dept.department_id as manager_dept_id',
          'manager_dept.department_name as manager_dept_name',
          'users.designation',
          'users.date_of_joining',
          'users.created_at',
          'users.profile_image_url',
          'users.location_tracking_enabled',
          'eed.employment_type',
          'eed.work_mode',
          'uo.onboarding_status as onboarding_status',
          'uo.kyc_status as kyc_status',
        );

      // Map frontend 'sortBy' values to database columns
      UserController.applyUserListSort(dataQuery, sortBy);

      const rows = await dataQuery.limit(limit).offset(offset);

      const managerUserIds = rows.filter((r: any) => r.role === 'manager').map((r: any) => r.id);
      const managerDepartmentsMap = await UserController.fetchManagerDepartmentsMap(
        org_id,
        managerUserIds,
      );

      const data = UserController.mapUserListRows(rows, managerDepartmentsMap);

      listPayload = {
        page: safePage,
        limit,
        total,
        total_pages,
        data,
      };
    }

    let statisticsPayload: any | null = null;
    if (wantsStatistics) {
      statisticsPayload = await UserController.buildStatistics(
        org_id,
        role,
        {
          isManager,
          managedDepartmentIds,
        },
        {
          month,
          year,
        },
      );
    }

    if (view === 'statistics') return res.json(statisticsPayload);
    if (view === 'list') return res.json(listPayload);

    return res.json({
      ...(listPayload ?? {}),
      statistics: statisticsPayload,
    });
  }

  static async downloadUsersExcel(req: Request, res: Response): Promise<Response | void> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = userExcelDownloadQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const org_id = req.user.org_id;
    const isManager = req.user.role === 'manager';
    const kycFlowEnabled = await isKycFlowEnabledForOrg(org_id);

    let managedDepartmentIds: string[] = [];
    if (isManager) {
      managedDepartmentIds = await getManagedDepartmentIds(org_id, req.user.id);
    }

    const { role, month, year, department_id, department, status, search, sortBy } = parsed.data;

    const filterDepartmentId = department || department_id;
    const hasPeriodFilter = month !== undefined || year !== undefined;
    const now = new Date();
    const effectiveYear = year ?? now.getUTCFullYear();
    const effectiveMonth = month ?? now.getUTCMonth() + 1;
    const periodStart = new Date(Date.UTC(effectiveYear, effectiveMonth - 1, 1))
      .toISOString()
      .slice(0, 10);
    const periodEnd = new Date(Date.UTC(effectiveYear, effectiveMonth, 0))
      .toISOString()
      .slice(0, 10);

    const { baseQuery } = await UserController.buildUserListBaseQuery({
      org_id,
      isManager,
      managedDepartmentIds,
      kycFlowEnabled,
      filters: {
        role,
        filterDepartmentId,
        status,
        search,
        hasPeriodFilter,
        periodStart,
        periodEnd,
      },
    });

    const dataQuery = baseQuery
      .leftJoin('user_profiles as up', 'up.user_id', 'users.id')
      .select(
        'users.id',
        'users.employee_id',
        'users.first_name',
        'users.last_name',
        'users.official_email',
        'users.role',
        'users.status',
        'users.designation',
        'users.department_id',
        'departments.name as department_name',
        'users.date_of_joining',
        'eed.employment_type',
        'eed.work_mode',
        'up.dob',
        'up.gender',
        'up.marital_status',
        'up.blood_group',
        'up.nationality',
        'up.personal_email',
        'up.personal_phone',
        'up.emergency_contact_name',
        'up.emergency_contact_phone',
        'up.permanent_address',
      );

    UserController.applyUserListSort(dataQuery, sortBy);

    const rows = (await dataQuery) as unknown as (UserDetailsExcelRow & {
      id: string;
      role?: string | null;
    })[];

    if (rows.length === 0) {
      return res.status(404).json({ message: 'No employees found' });
    }

    const managerUserIds = rows.filter((r) => r.role === 'manager').map((r) => r.id);
    const managerDepartmentsMap = await UserController.fetchManagerDepartmentsMap(
      org_id,
      managerUserIds,
    );

    // Addresses live in the `addresses` table keyed by type, not on user_profiles
    const addressRows = await Address.query()
      .whereIn(
        'user_id',
        rows.map((r) => r.id),
      )
      .where('type', 'PERMANENT');
    const permanentAddressByUser = new Map<string, string>();
    for (const addr of addressRows) {
      const formatted = [addr.street_address, addr.city, addr.state, addr.zip_code, addr.country]
        .filter(Boolean)
        .join(', ');
      if (formatted) {
        permanentAddressByUser.set(addr.user_id, formatted);
      }
    }

    const excelRows: UserDetailsExcelRow[] = rows.map((row) => {
      // Managers can span several departments via department_managers
      const names = new Set<string>();
      if (row.department_name) names.add(row.department_name);
      for (const dept of managerDepartmentsMap.get(row.id) ?? []) {
        names.add(dept.name);
      }
      return {
        ...row,
        department_name: names.size > 0 ? [...names].join(', ') : null,
        permanent_address: permanentAddressByUser.get(row.id) ?? row.permanent_address ?? null,
      };
    });

    const buffer = await generateUserDetailsExcelBuffer({ rows: excelRows });
    const fileName = userDetailsExcelFileName();

    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': buffer.length.toString(),
    });

    res.end(buffer);
  }

  static async getUpcomingBirthdays(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = upcomingBirthdaysQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { days, limit } = parsed.data;
    const org_id = req.user.org_id;
    const kycFlowEnabled = await isKycFlowEnabledForOrg(org_id);

    const rows = await User.query()
      .alias('u')
      .leftJoin('departments as d', 'd.id', 'u.department_id')
      .leftJoin('user_profiles as up', 'up.user_id', 'u.id')
      .where('u.org_id', org_id)
      .whereIn('u.status', ATTENDANCE_ACTIVE_EMPLOYEE_STATUSES as readonly string[])
      .whereNull('u.deleted_at')
      .whereNotNull('up.dob')
      .modify((qb) => {
        if (kycFlowEnabled) {
          applyExcludeInProgressOnboardingFilter(qb, 'u');
        }
      })
      // Org-wide across all org user roles (no department scoping)
      .whereIn('u.role', ORG_USER_ROLES)
      .select(
        'u.id',
        'u.employee_id',
        'u.first_name',
        'u.last_name',
        'u.profile_image_url',
        'u.role',
        'u.department_id',
        'd.name as department_name',
        'up.dob',
      );

    // Anchor the window to the current IST calendar day; the arithmetic below stays on
    // UTC-midnight anchors so day differences are exact.
    const todayStr = getTodayDate();
    const [todayYear, todayMonth, todayDay] = todayStr.split('-').map(Number);
    const today = new Date(Date.UTC(todayYear, todayMonth - 1, todayDay));
    const msPerDay = 86_400_000;

    const buildBirthdayDate = (year: number, monthIndex: number, dayOfMonth: number) => {
      const maxDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
      const safeDay = Math.min(dayOfMonth, maxDay);
      return new Date(Date.UTC(year, monthIndex, safeDay));
    };

    const items = (rows as any[])
      .map((row) => {
        const dobStr = normalizeDate(row.dob);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dobStr)) return null;

        const [birthYear, birthMonthNumber, birthDay] = dobStr.split('-').map(Number);
        const birthMonth = birthMonthNumber - 1;

        let nextBirthday = buildBirthdayDate(today.getUTCFullYear(), birthMonth, birthDay);
        if (nextBirthday < today) {
          nextBirthday = buildBirthdayDate(today.getUTCFullYear() + 1, birthMonth, birthDay);
        }

        const daysUntil = Math.floor((nextBirthday.getTime() - today.getTime()) / msPerDay);
        if (daysUntil < 0 || daysUntil > days) return null;

        const fullName = `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim();
        return {
          user: {
            id: row.id,
            employee_id: row.employee_id,
            full_name: fullName,
            role: row.role,
            department: row.department_id
              ? { id: row.department_id, name: row.department_name }
              : null,
            profile_image_url: row.profile_image_url ?? null,
          },
          date_of_birth: row.dob,
          next_birthday: nextBirthday.toISOString().slice(0, 10),
          days_until: daysUntil,
          turning_age: nextBirthday.getUTCFullYear() - birthYear,
        };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => {
        if (a.days_until !== b.days_until) return a.days_until - b.days_until;
        return a.user.full_name.localeCompare(b.user.full_name);
      })
      .slice(0, limit);

    return res.json({
      date: todayStr,
      window_days: days,
      count: items.length,
      items,
    });
  }

  static async listUnassigned(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = userUnassignedQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const org_id = req.user.org_id;
    const { role, status } = parsed.data;
    const kycFlowEnabled = await isKycFlowEnabledForOrg(org_id);

    // Get all user IDs who are managers of any department in this org
    const managerUserRows = await knex
      .select('dm.manager_id')
      .from('department_managers as dm')
      .innerJoin('departments as d', 'd.id', 'dm.department_id')
      .where('d.org_id', org_id)
      .whereNull('d.deleted_at');

    const managerUserIds = managerUserRows.map((row: any) => row.manager_id);

    let query = User.query()
      .where('org_id', org_id)
      .whereNull('deleted_at')
      .whereNull('department_id')
      .whereNot('role', 'admin');
    if (kycFlowEnabled) {
      query = applyExcludeInProgressOnboardingFilter(query, 'users');
    }

    // Exclude users who are managers of any department
    if (managerUserIds.length > 0) {
      query = query.whereNotIn('id', managerUserIds);
    }

    if (role) {
      query = query.where('role', role);
    }

    if (status !== 'ALL') {
      query = query.where('status', status);
    }

    const users = await query.select(
      'id',
      'employee_id',
      'first_name',
      'last_name',
      'profile_image_url',
      'official_email',
      'role',
      'status',
    );

    const items = users.map((u) => ({
      id: u.id,
      employee_id: u.employee_id,
      full_name: `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim(),
      first_name: u.first_name,
      last_name: u.last_name,
      profile_image_url: (u as any).profile_image_url ?? null,
      official_email: u.official_email,
      role: u.role,
      status: u.status,
    }));

    return res.json({ items });
  }

  /** Admin/HR: issue a new temporary password, email it, revoke sessions, invalidate OTP reset rows. */
  static async sendTemporaryPassword(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = sendTemporaryPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const org_id = req.user.org_id;
    const emailNormalized = parsed.data.email.trim().toLowerCase();

    const eligibleUserQuery = () =>
      User.query()
        .where('org_id', org_id)
        .whereNull('deleted_at')
        .whereNot('status', 'INACTIVE')
        .whereNot('role', 'device');

    let targetUser = await eligibleUserQuery().where('official_email', emailNormalized).first();
    if (!targetUser) {
      targetUser = await eligibleUserQuery()
        .whereRaw('LOWER(TRIM(official_email)) = ?', [emailNormalized])
        .first();
    }

    if (!targetUser) {
      return res
        .status(404)
        .json({ message: 'No user found with this email in your organization' });
    }

    const tempPassword = generateTempPassword();
    const [password_hash, organization] = await Promise.all([
      bcrypt.hash(tempPassword, 10),
      Organization.query().findById(org_id),
    ]);

    const nowIso = new Date().toISOString();
    // Keep the request path fast: only update the user's password synchronously.
    await User.transaction(async (trx) => {
      await User.query(trx).patchAndFetchById(targetUser.id, {
        password_hash,
        must_change_password: true,
      });

      if (isAdminOrHrRole(targetUser.role)) {
        await syncAdminHrPasswordByEmail(
          targetUser.official_email,
          { password_hash, must_change_password: true },
          { exceptUserId: targetUser.id, trx },
        );
      }
    });

    const orgName = organization?.name ?? 'Your Organization';
    const employeeName =
      `${targetUser.first_name ?? ''} ${targetUser.last_name ?? ''}`.trim() || 'User';

    const mailVariables = {
      ORG_NAME: orgName,
      EMPLOYEE_NAME: employeeName,
      LOGIN_EMAIL: targetUser.official_email,
      TEMP_PASSWORD: tempPassword,
      IOS_APP_URL: process.env.IOS_APP_URL ?? '',
      ANDROID_APP_URL: process.env.ANDROID_APP_URL ?? '',
    };

    // Return immediately; do heavier work after the response is scheduled.
    const response = res.json({
      message: "A temporary password has been sent to the user's official email address.",
    });

    setImmediate(() => {
      void (async () => {
        try {
          await User.transaction(async (trx) => {
            await RefreshToken.query(trx)
              .patch({ revoked_at: nowIso })
              .where('subject_type', 'tenant')
              .where('subject_id', targetUser.id)
              .where('org_id', org_id)
              .whereNull('revoked_at');

            await PasswordResetToken.query(trx)
              .patch({ consumed_at: nowIso })
              .where({ user_id: targetUser.id })
              .whereNull('consumed_at');
          });
        } catch (err) {
          logger.error(
            { err, userId: targetUser.id, org_id },
            'Admin temp password: failed to revoke refresh tokens / consume reset tokens',
          );
        }

        try {
          const mailResult = await sendMsg91Email({
            toEmail: targetUser.official_email,
            toName: employeeName,
            templateId: 'reset_password_email_template',
            variables: mailVariables,
          });
          if (!mailResult.success) {
            logger.error(
              { err: mailResult.error, userId: targetUser.id, org_id },
              'Admin temp password: Msg91 email failed (async)',
            );
          }
        } catch (err) {
          logger.error(
            { err, userId: targetUser.id, org_id },
            'Admin temp password: Msg91 email threw (async)',
          );
        }
      })();
    });

    return response;
  }

  static async downloadBulkImportTemplate(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const departments = await Department.query()
      .where({ org_id: req.user.org_id })
      .whereNull('deleted_at')
      .select('id', 'name')
      .orderBy('name');

    const buffer = await buildBulkImportTemplateBuffer(departments);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${BULK_IMPORT_TEMPLATE_FILENAME}"`);
    return res.send(buffer);
  }

  static async bulkImportUsers(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsedQuery = bulkImportQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsedQuery.error.flatten().fieldErrors,
      });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const org_id = req.user.org_id;
    const dryRun = parsedQuery.data.dry_run;
    const actorName = `${req.user.first_name ?? ''} ${req.user.last_name ?? ''}`.trim() || 'Admin';

    let parsedRows;
    try {
      parsedRows = parseAndPrepareBulkImport(req.file.buffer);
    } catch (error) {
      if (error instanceof BulkImportParseError) {
        return res.status(400).json({ message: error.message });
      }
      throw error;
    }

    const outcome = dryRun
      ? await validateBulkImportRows(parsedRows, org_id)
      : await importBulkUsers({
          parsedRows,
          orgId: org_id,
          actorUserId: req.user.id,
          actorName,
        });

    return res.status(200).json({
      message: dryRun ? 'Bulk import validation completed' : 'Bulk import completed',
      dry_run: dryRun,
      summary: outcome.summary,
      results: outcome.results,
    });
  }

  private static mapUserListRows(
    rows: any[],
    managerDepartmentsMap: Map<string, Array<{ id: string; name: string }>>,
  ) {
    return rows.map((r: any) => {
      const isManager = r.role === 'manager';

      if (isManager) {
        const managerDepts = managerDepartmentsMap.get(r.id) || [];
        if (r.department_id && !managerDepts.find((d: any) => d.id === r.department_id)) {
          managerDepts.push({
            id: r.department_id,
            name: r.department_name,
          });
        }
        return {
          id: r.id,
          employee_id: r.employee_id,
          full_name: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(),
          first_name: r.first_name,
          last_name: r.last_name,
          official_email: r.official_email,
          role: r.role,
          department: managerDepts.length > 0 ? managerDepts : null,
          designation: r.designation ?? null,
          date_of_joining: r.date_of_joining ?? null,
          status: r.status,
          profile_image_url: r.profile_image_url ?? null,
          employment_type: r.employment_type ?? null,
          work_mode: r.work_mode ?? null,
          onboarding_status: r.onboarding_status ?? null,
          kyc_status: r.kyc_status ?? null,
          location_tracking_enabled: r.location_tracking_enabled ?? null,
        };
      }

      const deptId = r.department_id || r.manager_dept_id;
      const deptName = r.department_name || r.manager_dept_name;
      return {
        id: r.id,
        employee_id: r.employee_id,
        full_name: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(),
        first_name: r.first_name,
        last_name: r.last_name,
        official_email: r.official_email,
        role: r.role,
        department: deptId ? { id: deptId, name: deptName } : null,
        designation: r.designation ?? null,
        date_of_joining: r.date_of_joining ?? null,
        status: r.status,
        profile_image_url: r.profile_image_url ?? null,
        employment_type: r.employment_type ?? null,
        work_mode: r.work_mode ?? null,
        onboarding_status: r.onboarding_status ?? null,
        kyc_status: r.kyc_status ?? null,
        location_tracking_enabled: r.location_tracking_enabled ?? null,
      };
    });
  }

  private static async fetchManagerDepartmentsMap(
    org_id: string,
    managerUserIds: string[],
  ): Promise<Map<string, Array<{ id: string; name: string }>>> {
    const managerDepartmentsMap = new Map<string, Array<{ id: string; name: string }>>();
    if (managerUserIds.length === 0) {
      return managerDepartmentsMap;
    }

    const managerDepts = await knex
      .select('dm.manager_id', 'd.id as department_id', 'd.name as department_name')
      .from('department_managers as dm')
      .innerJoin('departments as d', 'd.id', 'dm.department_id')
      .where('d.org_id', org_id)
      .whereNull('d.deleted_at')
      .whereIn('dm.manager_id', managerUserIds)
      .orderBy('dm.created_at', 'asc');

    for (const row of managerDepts) {
      const managerId = row.manager_id;
      if (!managerDepartmentsMap.has(managerId)) {
        managerDepartmentsMap.set(managerId, []);
      }
      managerDepartmentsMap.get(managerId)!.push({
        id: row.department_id,
        name: row.department_name,
      });
    }

    return managerDepartmentsMap;
  }

  private static formatPastUserExit(exit: UserExit | null | undefined) {
    if (!exit) {
      return null;
    }

    return {
      id: exit.id,
      exit_type: exit.exit_type,
      last_working_day: exit.last_working_day,
      exited_at: exit.exited_at ?? null,
    };
  }

  private static async fetchPastUsersForStatistics(
    org_id: string,
    roleFilter?: OrgUserRole,
    managerScope?: { isManager: boolean; managedDepartmentIds: string[] },
  ): Promise<{ count: number; data: Array<Record<string, unknown>> }> {
    const kycFlowEnabled = await isKycFlowEnabledForOrg(org_id);
    const isManager = managerScope?.isManager ?? false;
    const managedDepartmentIds = managerScope?.managedDepartmentIds ?? [];

    const managerDeptSubquery = knex
      .select('manager_id', 'department_id', 'department_name')
      .from(
        knex
          .select(
            'dm.manager_id',
            'dm.department_id',
            'd.name as department_name',
            knex.raw(
              'ROW_NUMBER() OVER (PARTITION BY dm.manager_id ORDER BY dm.created_at ASC) as rn',
            ),
          )
          .from('department_managers as dm')
          .innerJoin('departments as d', 'd.id', 'dm.department_id')
          .where('d.org_id', org_id)
          .whereNull('d.deleted_at')
          .as('ranked'),
      )
      .where('rn', 1)
      .as('manager_dept');

    let baseQuery = User.query()
      .alias('users')
      .leftJoin('departments', 'departments.id', 'users.department_id')
      .leftJoin(managerDeptSubquery, 'manager_dept.manager_id', 'users.id')
      .leftJoin('employee_employment_details as eed', 'eed.user_id', 'users.id')
      .leftJoin('user_onboardings as uo', 'uo.user_id', 'users.id')
      .where('users.org_id', org_id)
      .whereIn('users.role', ORG_USER_ROLES)
      .where('users.status', 'INACTIVE')
      .whereNull('users.deleted_at');

    if (kycFlowEnabled) {
      applyExcludeInProgressOnboardingFilter(baseQuery, 'users');
    }

    if (isManager) {
      if (managedDepartmentIds.length === 0) {
        baseQuery.whereRaw('1 = 0');
      } else {
        const managerSubquery = DepartmentManager.query()
          .alias('dm')
          .whereIn('dm.department_id', managedDepartmentIds)
          .select('dm.manager_id');

        baseQuery.where((b) => {
          b.whereIn('users.department_id', managedDepartmentIds)
            .whereIn('users.role', ['employee', 'hr'])
            .orWhereIn('users.id', managerSubquery);
        });
      }
    }

    if (roleFilter) {
      baseQuery = baseQuery.where('users.role', roleFilter);
    }

    const listSelect = [
      'users.id',
      'users.employee_id',
      'users.first_name',
      'users.last_name',
      'users.official_email',
      'users.role',
      'users.status',
      'users.department_id',
      'departments.name as department_name',
      'manager_dept.department_id as manager_dept_id',
      'manager_dept.department_name as manager_dept_name',
      'users.designation',
      'users.date_of_joining',
      'users.created_at',
      'users.updated_at',
      'users.profile_image_url',
      'users.location_tracking_enabled',
      'eed.employment_type',
      'eed.work_mode',
      'uo.onboarding_status as onboarding_status',
      'uo.kyc_status as kyc_status',
    ];

    const [countRow, rows] = await Promise.all([
      baseQuery.clone().countDistinct('users.id as count').first(),
      baseQuery.clone().select(listSelect).orderBy('users.updated_at', 'desc'),
    ]);

    const count = Number((countRow as unknown as { count?: string | number })?.count ?? 0);
    const rowList = rows as any[];

    const managerUserIds = rowList.filter((r) => r.role === 'manager').map((r) => r.id);
    const managerDepartmentsMap = await UserController.fetchManagerDepartmentsMap(
      org_id,
      managerUserIds,
    );

    const userIds = rowList.map((r) => r.id);
    const exitRows =
      userIds.length > 0
        ? await UserExit.query()
            .where('org_id', org_id)
            .whereIn('user_id', userIds)
            .where('status', 'COMPLETED')
            .orderBy('exited_at', 'desc')
        : [];

    const exitByUserId = new Map<string, UserExit>();
    for (const exit of exitRows) {
      if (!exitByUserId.has(exit.user_id)) {
        exitByUserId.set(exit.user_id, exit);
      }
    }

    const withSort = rowList.map((r) => {
      const exit = exitByUserId.get(r.id);
      const exitedAt = exit?.exited_at ? new Date(exit.exited_at).getTime() : NaN;
      const updatedAt = r.updated_at ? new Date(r.updated_at).getTime() : 0;
      const sortAt = Number.isFinite(exitedAt) ? exitedAt : updatedAt;
      return { r, exit, sortAt };
    });
    withSort.sort((a, b) => b.sortAt - a.sortAt);

    const data = withSort.map(({ r, exit }) => {
      const [mapped] = UserController.mapUserListRows([r], managerDepartmentsMap);
      return {
        ...mapped,
        exit: UserController.formatPastUserExit(exit),
      };
    });

    return { count, data };
  }

  private static async buildStatistics(
    org_id: string,
    roleFilter?: OrgUserRole,
    managerScope?: { isManager: boolean; managedDepartmentIds: string[] },
    period?: { month?: number; year?: number },
  ) {
    const kycFlowEnabled = await isKycFlowEnabledForOrg(org_id);

    // Get current date info (using UTC to avoid timezone issues)
    const now = new Date();
    const currentYear = period?.year ?? now.getUTCFullYear();
    const currentMonth = period?.month ?? now.getUTCMonth() + 1; // 1-12

    // Calculate first and last day of current month (UTC)
    const firstDayOfMonth = new Date(Date.UTC(currentYear, currentMonth - 1, 1));
    const lastDayOfMonth = new Date(Date.UTC(currentYear, currentMonth, 0, 23, 59, 59, 999));

    // Calculate first and last day of previous month (UTC)
    const prevMonthDate = new Date(Date.UTC(currentYear, currentMonth - 2, 1));
    const prevYear = prevMonthDate.getUTCFullYear();
    const prevMonth = prevMonthDate.getUTCMonth() + 1; // 1-12
    const firstDayOfPrevMonth = new Date(Date.UTC(prevYear, prevMonth - 1, 1));
    const lastDayOfPrevMonth = new Date(Date.UTC(prevYear, prevMonth, 0, 23, 59, 59, 999));

    // Helper to apply manager scoping: include employees/HR in managed departments
    // AND managers assigned to those departments (no extra field in response).
    const applyManagerScope = (query: any) => {
      if (!managerScope?.isManager) {
        return query;
      }

      const deptIds = managerScope.managedDepartmentIds ?? [];
      if (deptIds.length === 0) {
        return query.whereRaw('1 = 0');
      }

      const managerSubquery = DepartmentManager.query()
        .alias('dm')
        .whereIn('dm.department_id', deptIds)
        .select('dm.manager_id');

      return query.where((b: any) => {
        b.whereIn('department_id', deptIds)
          .whereIn('role', ['employee', 'hr'])
          .orWhereIn('id', managerSubquery);
      });
    };

    // Active workforce only (ACTIVE + ON_NOTICE); INACTIVE users are in past_users.
    const buildBaseQuery = () => {
      let query = User.query()
        .where('org_id', org_id)
        .whereIn('role', ORG_USER_ROLES)
        .whereIn('status', ATTENDANCE_ACTIVE_EMPLOYEE_STATUSES as readonly string[])
        .whereNull('deleted_at');
      if (kycFlowEnabled) {
        query = applyExcludeInProgressOnboardingFilter(query, 'users');
      }

      query = applyManagerScope(query);

      if (roleFilter) {
        query = query.where('role', roleFilter);
      }
      return query;
    };

    // Resigned query builder (does NOT filter deleted_at, by design)
    const buildResignedQuery = () => {
      let q = User.query().where('org_id', org_id).whereIn('role', ORG_USER_ROLES);
      q = q.whereIn('status', REAL_EMPLOYEE_STATUSES as readonly string[]);
      if (kycFlowEnabled) {
        q = applyExcludeInProgressOnboardingFilter(q, 'users');
      }

      q = applyManagerScope(q);

      if (roleFilter) q = q.where('role', roleFilter);
      return q;
    };

    // Workforce count as of endDate: active/on-notice now, or separated after endDate.
    const buildTotalAtEndOf = (endDate: Date) => {
      const endDateStr = endDate.toISOString().slice(0, 10);
      let q = User.query().where('org_id', org_id).whereIn('role', ORG_USER_ROLES);
      if (kycFlowEnabled) {
        q = applyExcludeInProgressOnboardingFilter(q, 'users');
      }

      q = applyManagerScope(q);

      if (roleFilter) q = q.where('role', roleFilter);
      return q
        .whereRaw('COALESCE(users.date_of_joining::date, users.created_at::date) <= ?::date', [
          endDateStr,
        ])
        .where((b) => {
          b.whereNull('deleted_at').orWhere('deleted_at', '>', endDate);
        })
        .where((b) => {
          b.whereIn('status', ATTENDANCE_ACTIVE_EMPLOYEE_STATUSES as readonly string[]).orWhere(
            (inactive) => {
              inactive.where('status', 'INACTIVE').where((separatedAfter) => {
                separatedAfter
                  .whereExists(
                    UserExit.query()
                      .select(1)
                      .whereColumn('user_exits.user_id', 'users.id')
                      .where('user_exits.org_id', org_id)
                      .where('user_exits.status', 'COMPLETED')
                      .whereRaw('user_exits.exited_at::date > ?::date', [endDateStr]),
                  )
                  .orWhere((legacy) => {
                    legacy
                      .whereNotExists(
                        UserExit.query()
                          .select(1)
                          .whereColumn('user_exits.user_id', 'users.id')
                          .where('user_exits.org_id', org_id)
                          .where('user_exits.status', 'COMPLETED'),
                      )
                      .where('users.updated_at', '>', endDate);
                  });
              });
            },
          );
        });
    };

    // Pre-compute ISO date strings for JOIN/CREATED date comparisons
    const currentPeriodStartStr = firstDayOfMonth.toISOString().slice(0, 10);
    const currentPeriodEndStr = lastDayOfMonth.toISOString().slice(0, 10);
    const prevPeriodStartStr = firstDayOfPrevMonth.toISOString().slice(0, 10);
    const prevPeriodEndStr = lastDayOfPrevMonth.toISOString().slice(0, 10);

    // Optimize: Run queries in parallel for better performance
    const [
      totalResult,
      newResult,
      resignedResult,
      totalPrevResult,
      newPrevResult,
      resignedPrevResult,
      pastUsersResult,
    ] = await Promise.all([
      // Total users now (excluding soft-deleted)
      buildBaseQuery().count('* as count').first(),
      // New users this month (based on joining date; fallback to created_at if joining date is null)
      buildBaseQuery()
        .whereRaw(
          'COALESCE(users.date_of_joining::date, users.created_at::date) BETWEEN ?::date AND ?::date',
          [currentPeriodStartStr, currentPeriodEndStr],
        )
        .count('* as count')
        .first(),
      // Resigned users this month (user_exits.exited_at preferred; legacy INACTIVE/deleted_at fallback)
      applyResignedUsersInPeriodFilter(
        buildResignedQuery(),
        org_id,
        firstDayOfMonth,
        lastDayOfMonth,
      )
        .count('* as count')
        .first(),
      // Total users at end of previous month
      buildTotalAtEndOf(lastDayOfPrevMonth).count('* as count').first(),
      // New users in previous month (based on joining date; fallback to created_at if joining date is null)
      buildBaseQuery()
        .whereRaw(
          'COALESCE(users.date_of_joining::date, users.created_at::date) BETWEEN ?::date AND ?::date',
          [prevPeriodStartStr, prevPeriodEndStr],
        )
        .count('* as count')
        .first(),
      // Resigned users in previous month
      applyResignedUsersInPeriodFilter(
        buildResignedQuery(),
        org_id,
        firstDayOfPrevMonth,
        lastDayOfPrevMonth,
      )
        .count('* as count')
        .first(),
      UserController.fetchPastUsersForStatistics(org_id, roleFilter, managerScope),
    ]);

    // Extract counts (PostgreSQL returns count as string, convert to number)
    // The count queries return raw rows, not User models – cast via unknown as suggested by TS.
    const totalCount = Number((totalResult as unknown as { count: string | number })?.count ?? 0);
    const newCount = Number((newResult as unknown as { count: string | number })?.count ?? 0);
    const resignedCount = Number(
      (resignedResult as unknown as { count: string | number })?.count ?? 0,
    );
    const totalPrevCount = Number(
      (totalPrevResult as unknown as { count: string | number })?.count ?? 0,
    );
    const newPrevCount = Number(
      (newPrevResult as unknown as { count: string | number })?.count ?? 0,
    );
    const resignedPrevCount = Number(
      (resignedPrevResult as unknown as { count: string | number })?.count ?? 0,
    );

    // Calculate turnover rate
    // Turnover rate (monthly): (Resigned in month / Total users) * 100
    let turnoverRate = 0;
    if (totalCount > 0) {
      turnoverRate = Math.round((resignedCount / totalCount) * 100 * 100) / 100; // Round to 2 decimal places
    }

    let turnoverRatePrev = 0;
    if (totalPrevCount > 0) {
      turnoverRatePrev = Math.round((resignedPrevCount / totalPrevCount) * 100 * 100) / 100;
    }

    const pctChange = (current: number, prev: number): number | null => {
      if (prev === 0) return current === 0 ? 0 : null;
      return Math.round(((current - prev) / prev) * 100 * 100) / 100;
    };

    return {
      total_users: totalCount,
      past_users_count: pastUsersResult.count,
      past_users: pastUsersResult.data,
      total_users_change_pct_from_last_month: pctChange(totalCount, totalPrevCount),
      new_users_this_month: newCount,
      new_users_change_pct_from_last_month: pctChange(newCount, newPrevCount),
      resigned_users_this_month: resignedCount,
      resigned_users_change_pct_from_last_month: pctChange(resignedCount, resignedPrevCount),
      turnover_rate: turnoverRate,
      turnover_rate_change_pct_from_last_month: pctChange(turnoverRate, turnoverRatePrev),
      filter: roleFilter ? { role: roleFilter } : null,
      period: {
        month: currentMonth,
        year: currentYear,
        start_date: firstDayOfMonth.toISOString().slice(0, 10),
        end_date: lastDayOfMonth.toISOString().slice(0, 10),
      },
      compare_period: {
        month: prevMonth,
        year: prevYear,
        start_date: firstDayOfPrevMonth.toISOString().slice(0, 10),
        end_date: lastDayOfPrevMonth.toISOString().slice(0, 10),
      },
    };
  }

  // Get employee profile (simple card view) - Admin/HR only
  static async getEmployeeProfile(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { userId } = req.params;
    const org_id = req.user.org_id;

    // Find user by id with related data
    const user = await User.query()
      .withGraphJoined('[department, profile, employmentDetails]')
      .where('users.org_id', org_id)
      .where('users.id', userId)
      .whereNull('users.deleted_at')
      .first();

    if (!user) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const userWithRelations = user as any;

    // Get address (prefer PRESENT, fallback to PERMANENT)
    const addresses = await Address.query().where({ user_id: user.id });
    const presentAddress = addresses.find((a) => a.type === 'PRESENT');
    const permanentAddress = addresses.find((a) => a.type === 'PERMANENT');
    const address = presentAddress ?? permanentAddress;

    // Format address string
    const formattedAddress = address
      ? [address.street_address, address.city, address.state, address.zip_code, address.country]
          .filter(Boolean)
          .join(', ')
      : null;

    // Format join date
    const joinDate = user.date_of_joining
      ? new Date(user.date_of_joining).toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        })
      : null;

    // Format date of birth
    const dateOfBirth = userWithRelations.profile?.dob
      ? new Date(userWithRelations.profile.dob).toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        })
      : null;

    const activeExit = await findActiveExit(org_id, user.id);

    // Build response matching the profile card structure
    return res.json({
      employee: {
        id: user.id,
        employee_id: user.employee_id,
        full_name: `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim(),
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
        status: user.status,
        designation: user.designation ?? null,
        department: userWithRelations.department
          ? {
              id: userWithRelations.department.id,
              name: userWithRelations.department.name,
              location_tracking_enabled:
                userWithRelations.department.location_tracking_enabled === true,
            }
          : null,
        profile_image_url: (user as any).profile_image_url ?? null,
        location_tracking_enabled: user.location_tracking_enabled ?? null,
      },
      employment_details: {
        employment_type: userWithRelations.employmentDetails?.employment_type ?? null,
        work_mode: userWithRelations.employmentDetails?.work_mode ?? null,
        join_date: joinDate,
      },
      personal_info: {
        gender: userWithRelations.profile?.gender ?? null,
        date_of_birth: dateOfBirth,
        email: userWithRelations.profile?.personal_email ?? user.official_email,
        phone: userWithRelations.profile?.personal_phone ?? null,
        address: formattedAddress,
      },
      exit: formatExitForProfile(activeExit),
    });
  }

  // Get employee documents list - Admin/HR only
  static async getEmployeeDocuments(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { userId } = req.params;
    const parsed = userDocumentListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { page, limit, category, status, search, sort_by, sort_dir } = parsed.data;
    const org_id = req.user.org_id;

    // Find user by id
    const user = await User.query()
      .where('org_id', org_id)
      .where('id', userId)
      .whereNull('deleted_at')
      .first();

    if (!user) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const user_id = user.id;

    // Base query for documents
    const baseQuery = UserDocument.query().alias('ud').where('ud.user_id', user_id);

    // Filters
    if (category) {
      baseQuery.where('ud.doc_category', category);
    }

    if (status) {
      baseQuery.where('ud.verification_status', status);
    }

    // Search (across doc_type and doc_category)
    if (search) {
      const term = `%${search}%`;
      baseQuery.where((qb) => {
        qb.where('ud.doc_type', 'ilike', term).orWhere('ud.doc_category', 'ilike', term);
      });
    }

    // Pagination stats
    const countRow = await baseQuery.clone().count('* as count').first();
    const total = Number((countRow as { count?: string | number } | undefined)?.count ?? 0);
    const total_pages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(Math.max(page, 1), total_pages);
    const offset = (safePage - 1) * limit;

    // Sorting
    if (sort_by === 'NAME') {
      baseQuery.orderBy('ud.doc_type', sort_dir === 'DESC' ? 'desc' : 'asc');
    } else if (sort_by === 'CATEGORY') {
      baseQuery.orderBy('ud.doc_category', sort_dir === 'DESC' ? 'desc' : 'asc');
    } else if (sort_by === 'STATUS') {
      baseQuery.orderBy('ud.verification_status', sort_dir === 'DESC' ? 'desc' : 'asc');
    } else {
      // Default: UPLOADED_DATE
      baseQuery.orderBy('ud.created_at', sort_dir === 'DESC' ? 'desc' : 'asc');
    }

    // Secondary sort for consistency
    baseQuery.orderBy('ud.created_at', 'desc');

    // Fetch data
    const rows = await baseQuery
      .clone()
      .select(
        'ud.id',
        'ud.doc_type',
        'ud.doc_category',
        'ud.file_url',
        'ud.verification_status',
        'ud.created_at',
      )
      .limit(limit)
      .offset(offset);

    // Helper to format date
    const formatDate = (date: Date | string): string => {
      const d = typeof date === 'string' ? new Date(date) : date;
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const docDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());

      // Check if it's today
      if (docDate.getTime() === today.getTime()) {
        const hours = d.getHours();
        const minutes = d.getMinutes();
        const ampm = hours >= 12 ? 'PM' : 'AM';
        const displayHours = hours % 12 || 12;
        const displayMinutes = String(minutes).padStart(2, '0');
        return `Today, ${displayHours}:${displayMinutes} ${ampm}`;
      }

      // Otherwise format as DD/MM/YYYY, HH:MM AM/PM
      const day = String(d.getDate()).padStart(2, '0');
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const year = d.getFullYear();
      const hours = d.getHours();
      const minutes = d.getMinutes();
      const ampm = hours >= 12 ? 'PM' : 'AM';
      const displayHours = hours % 12 || 12;
      const displayMinutes = String(minutes).padStart(2, '0');
      return `${day}/${month}/${year}, ${displayHours}:${displayMinutes} ${ampm}`;
    };

    const data = rows.map((r: any) => ({
      id: r.id,
      document_name: r.doc_type,
      category: r.doc_category,
      uploaded_date: formatDate(r.created_at),
      view: r.file_url,
      status: r.verification_status,
    }));

    return res.json({
      page: safePage,
      limit,
      total,
      total_pages,
      data,
    });
  }

  // Get employee leaves (summary cards + calendar) - Admin/HR only
  static async getEmployeeLeaves(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { userId } = req.params;
    const parsedUserId = z.string().uuid().safeParse(userId);
    if (!parsedUserId.success) {
      return res.status(400).json({ message: 'Invalid userId path parameter' });
    }

    const parsed = employeeLeavesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const org_id = req.user.org_id;
    const now = new Date();
    const month = parsed.data.month ?? now.getMonth() + 1;
    const year = parsed.data.year ?? now.getFullYear();

    // Find user by id
    const user = await User.query()
      .where('org_id', org_id)
      .where('id', parsedUserId.data)
      .whereNull('deleted_at')
      .first();

    if (!user) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const user_id = user.id;

    // Helper functions
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

    // Get current year range
    const currentYear = year;
    const { start: yearStart, end: yearEnd } = getYearRange(currentYear);

    const department =
      user.department_id != null
        ? await Department.query().findById(user.department_id).select('working_days')
        : null;
    const managedScheduleByManagerId =
      user.role === 'manager'
        ? await fetchPrimaryManagedDepartmentScheduleByManagerIds(org_id, [user_id])
        : undefined;
    const leaveSchedule = resolveLeaveScheduleForRow(
      {
        role: user.role,
        department_id: user.department_id,
        department_working_days: department?.working_days,
        user_id,
      },
      managedScheduleByManagerId,
    );
    const yearHolidaySet = await fetchEffectiveHolidayDateSet(org_id, user_id, yearStart, yearEnd);

    // Fetch leave types and leave requests for the year
    const [leaveTypes, yearLeaves] = await Promise.all([
      LeaveType.query().where('org_id', org_id).orderBy('name', 'asc'),
      LeaveRequest.query()
        .where('org_id', org_id)
        .where('user_id', user_id)
        .where((qb) => {
          qb.whereBetween('start_date', [yearStart, yearEnd])
            .orWhereBetween('end_date', [yearStart, yearEnd])
            .orWhere((subQb) => {
              subQb.where('start_date', '<=', yearStart).where('end_date', '>=', yearEnd);
            });
        })
        .whereIn('status', ['PENDING', 'APPROVED']),
    ]);

    // Calculate leave summary by type
    const leaveSummaryByType = new Map<
      string,
      { approved_days: number; pending_days: number; quota: number }
    >();

    const doj = user.date_of_joining ?? '2000-01-01';

    for (const leaveType of leaveTypes) {
      const effectiveQuota = calculateEffectiveQuota(leaveType.annual_quota, doj, currentYear);
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

    // Calculate leave balances
    let allLeavesUsed = 0;
    let allLeavesQuota = 0;
    const dynamicLeaveSummary: Record<string, { used: number; quota: number }> = {};

    const dynamicTypesSummary: Array<{
      id: string;
      name: string;
      used: number;
      quota: number;
    }> = [];

    for (const leaveType of leaveTypes) {
      const typeData = leaveSummaryByType.get(leaveType.id);
      const used = typeData?.approved_days ?? 0;
      const quota = typeData?.quota ?? 0;

      allLeavesUsed += used;
      allLeavesQuota += quota;

      // Dynamic summary key derived from leave type name.
      // Example: "Sick Leave" -> "sick_leave_leaves"
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

    // Get calendar data for the specified month
    const startOfMonth = new Date(year, month - 1, 1);
    const endOfMonth = new Date(year, month, 0);
    const monthStart = formatDateLocal(startOfMonth);
    const monthEnd = formatDateLocal(endOfMonth);
    const today = formatDateLocal(new Date());
    const joinDateStr = user.date_of_joining ? formatDateLocal(user.date_of_joining) : null;
    const effectiveStart = joinDateStr && joinDateStr > monthStart ? joinDateStr : monthStart;
    const nonFutureEnd = today < monthEnd ? today : monthEnd;
    const effectiveEnd = monthEnd;

    // Fetch attendance logs up to today and approved leaves for the full effective month range.
    // Future dates will be returned only when they are ON_LEAVE.
    const [monthLogs, monthLeaves] = await Promise.all([
      AttendanceLog.query()
        .where('org_id', org_id)
        .where('user_id', user_id)
        .whereBetween('date', [effectiveStart, nonFutureEnd]),
      LeaveRequest.query()
        .where('org_id', org_id)
        .where('user_id', user_id)
        .where('status', 'APPROVED')
        .where((qb) => {
          qb.whereBetween('start_date', [effectiveStart, effectiveEnd])
            .orWhereBetween('end_date', [effectiveStart, effectiveEnd])
            .orWhere((subQb) => {
              subQb.where('start_date', '<=', effectiveStart).where('end_date', '>=', effectiveEnd);
            });
        }),
    ]);

    // Build maps for quick lookup
    const logsByDate = new Map<string, AttendanceLog>();
    for (const log of monthLogs) {
      logsByDate.set(formatDateLocal(log.date), log);
    }

    const leavesByDate = new Set<string>();
    for (const leave of monthLeaves) {
      const start = new Date(leave.start_date);
      const end = new Date(leave.end_date);
      const current = new Date(start);
      while (current <= end) {
        const key = formatDateLocal(current);
        if (key >= effectiveStart && key <= effectiveEnd) {
          leavesByDate.add(key);
        }
        current.setDate(current.getDate() + 1);
      }
    }

    const [holidaySet, scheduleRowLeaves] = await Promise.all([
      fetchEffectiveHolidayDateSet(org_id, user_id, monthStart, monthEnd),
      User.query()
        .alias('u')
        .leftJoin('departments as d', 'd.id', 'u.department_id')
        .where('u.id', user_id)
        .where('u.org_id', org_id)
        .select('u.department_id', 'd.working_days as department_working_days')
        .first(),
    ]);

    let leavesManagedScheduleFallback:
      | { departmentId: string; workingDays: string[] | null }
      | undefined;
    if (user.role === 'manager') {
      const fbMap = await fetchPrimaryManagedDepartmentScheduleByManagerIds(org_id, [
        String(user_id),
      ]);
      leavesManagedScheduleFallback = fbMap.get(String(user_id));
    }
    const effScheduleLeaves = resolveEffectiveAttendanceSchedule(
      {
        role: user.role,
        department_id: scheduleRowLeaves?.department_id ?? null,
        department_working_days: (scheduleRowLeaves as any)?.department_working_days,
      },
      leavesManagedScheduleFallback,
    );

    // Build calendar entries
    const calendarEntries: Array<{
      date: string;
      status: 'PRESENT' | 'LATE' | 'LEAVE' | 'ABSENT';
    }> = [];

    let presentCount = 0;
    let lateCount = 0;
    let onLeaveCount = 0;
    let absentCount = 0;

    if (effectiveStart <= effectiveEnd) {
      const cursor = new Date(effectiveStart);
      const effectiveEndDate = new Date(effectiveEnd);
      while (cursor <= effectiveEndDate) {
        const dateKey = formatDateLocal(cursor);

        const logRowLeaves = logsByDate.get(dateKey);
        if (
          shouldOmitAttendanceCalendarDate({
            dateStr: dateKey,
            holidaySet,
            departmentId: effScheduleLeaves.departmentId,
            workingDays: effScheduleLeaves.workingDays,
            hasLog: Boolean(logRowLeaves),
            hasPendingCorrection: false,
          })
        ) {
          cursor.setDate(cursor.getDate() + 1);
          continue;
        }

        const log = logRowLeaves;
        const isOnLeave = leavesByDate.has(dateKey);
        const isFutureDate = dateKey > today;

        if (isFutureDate && !isOnLeave) {
          cursor.setDate(cursor.getDate() + 1);
          continue;
        }

        if (isOnLeave) {
          calendarEntries.push({ date: dateKey, status: 'LEAVE' });
          onLeaveCount++;
        } else if (log) {
          // Check if late (simplified - would need shift info for accurate check)
          // For now, we'll use a simple heuristic: if clock_in_time is after 9:30 AM, consider it late
          let isLate = false;
          if (log.clock_in_time) {
            const clockIn = new Date(log.clock_in_time);
            const hours = clockIn.getHours();
            const minutes = clockIn.getMinutes();
            // Consider late if after 9:30 AM
            if (hours > 9 || (hours === 9 && minutes > 30)) {
              isLate = true;
            }
          }
          const status = isLate ? 'LATE' : 'PRESENT';
          calendarEntries.push({ date: dateKey, status });
          if (isLate) {
            lateCount++;
          } else {
            presentCount++;
          }
        } else {
          calendarEntries.push({ date: dateKey, status: 'ABSENT' });
          absentCount++;
        }

        cursor.setDate(cursor.getDate() + 1);
      }
    }

    return res.json({
      leave_summary: {
        all_leaves: {
          used: allLeavesUsed,
          quota: allLeavesQuota,
        },
        ...dynamicLeaveSummary,
        types: dynamicTypesSummary,
      },
      calendar: {
        month,
        year,
        entries: calendarEntries,
        legend: {
          present: presentCount,
          late: lateCount,
          on_leave: onLeaveCount,
          absent: absentCount,
        },
      },
    });
  }

  // Get employee payrolls (paginated list) - Admin/HR only
  static async getEmployeePayrolls(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Avoid stale 304/cached payroll totals after adjustments.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const { userId } = req.params;
    const parsed = employeePayrollsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const org_id = req.user.org_id;
    const { page, limit, month, year, status } = parsed.data;

    // Find user by id
    const user = await User.query()
      .where('org_id', org_id)
      .where('id', userId)
      .whereNull('deleted_at')
      .first();

    if (!user) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const user_id = user.id;

    try {
      // Base query
      const baseQuery = PayrollRecord.query().where('org_id', org_id).where('user_id', user_id);

      // Filters
      if (month) {
        baseQuery.where('payroll_month', month);
      }
      if (year) {
        baseQuery.where('payroll_year', year);
      }
      if (status) {
        baseQuery.where('status', status);
      }

      // Pagination stats
      const countRow = await baseQuery.clone().count('* as count').first();
      const total = Number((countRow as { count?: string | number } | undefined)?.count ?? 0);
      const total_pages = Math.max(1, Math.ceil(total / limit));
      const safePage = Math.min(Math.max(page, 1), total_pages);
      const offset = (safePage - 1) * limit;

      // Sort by date (most recent first)
      baseQuery.orderBy('payroll_year', 'desc');
      baseQuery.orderBy('payroll_month', 'desc');
      baseQuery.orderBy('created_at', 'desc');

      // Fetch data
      const records = await baseQuery
        .clone()
        .withGraphFetched('salaryStructure')
        .limit(limit)
        .offset(offset);

      // Helper to format date as ISO date string (YYYY-MM-DD)
      const formatPayrollDate = (month: number, year: number): string => {
        const monthStr = String(month).padStart(2, '0');
        return `${year}-${monthStr}-01`;
      };

      const displayAmountsList = await resolvePayrollListDisplayAmountsBatch(
        records.map((record: any) => payrollRecordToPayslipPayPeriodInput(record, org_id, user_id)),
      );

      const data = records.map((record: any, index: number) => {
        const display = displayAmountsList[index];
        const gross_salary = Number(record.gross_salary || 0);
        const allowances = Number(record.allowance_amount || 0);
        const overtime = Number(record.overtime_amount || 0);

        return {
          id: record.id,
          month: record.payroll_month,
          year: record.payroll_year,
          date: formatPayrollDate(record.payroll_month, record.payroll_year),
          gross_salary,
          allowances,
          overtime,
          incentives: display.incentives,
          deductions: display.deductions,
          total: display.total,
          net_salary: display.net_salary,
          status: record.status,
          payslip_url: record.payslip_pdf_url ?? null,
          created_at: record.created_at,
          updated_at: record.updated_at,
        };
      });

      return res.json({
        page: safePage,
        limit,
        total,
        total_pages,
        items: data,
      });
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to fetch employee payrolls',
      });
    }
  }

  static async getEmployeeDetails(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { userId } = req.params;
    const org_id = req.user.org_id;

    // Parse query params for calendar month/year
    const month = req.query.month ? Number(req.query.month) : new Date().getMonth() + 1;
    const year = req.query.year ? Number(req.query.year) : new Date().getFullYear();

    // Find user by id
    const user = await User.query()
      .withGraphJoined('[department, profile, employmentDetails]')
      .where('users.org_id', org_id)
      .where('users.id', userId)
      .whereNull('users.deleted_at')
      .first();

    if (!user) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const user_id = user.id;
    const userWithRelations = user as any; // Type assertion for graph-joined relations

    // Helper to format date as YYYY-MM-DD
    const formatDateLocal = (date: Date | string): string => {
      const d = typeof date === 'string' ? new Date(date) : date;
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    // Helper to get year range
    const getYearRange = (year: number): { start: string; end: string } => {
      const start = new Date(Date.UTC(year, 0, 1));
      const end = new Date(Date.UTC(year, 11, 31));
      return {
        start: start.toISOString().slice(0, 10),
        end: end.toISOString().slice(0, 10),
      };
    };

    // Fetch all data in parallel
    const [
      profile,
      employmentDetails,
      addresses,
      documents,
      leaveTypes,
      currentYearLeaves,
      currentWeekLogs,
      monthLogs,
      payrollRecords,
    ] = await Promise.all([
      UserProfile.query().findOne({ user_id }),
      EmployeeEmploymentDetail.query().findOne({ user_id }),
      Address.query().where({ user_id }),
      UserDocument.query().where({ user_id }).orderBy('created_at', 'desc'),
      LeaveType.query().where('org_id', org_id).orderBy('name', 'asc'),
      LeaveRequest.query()
        .where('org_id', org_id)
        .where('user_id', user_id)
        .whereIn('status', ['PENDING', 'APPROVED']),
      // Get current week logs (Monday to Sunday)
      (async () => {
        const today = new Date();
        const dayOfWeek = today.getDay();
        const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
        const mondayDate = new Date(today);
        mondayDate.setDate(today.getDate() + mondayOffset);
        const sundayDate = new Date(mondayDate);
        sundayDate.setDate(mondayDate.getDate() + 6);
        const weekStart = formatDateLocal(mondayDate);
        const weekEnd = formatDateLocal(sundayDate);
        return AttendanceLog.query()
          .where('org_id', org_id)
          .where('user_id', user_id)
          .whereBetween('date', [weekStart, weekEnd]);
      })(),
      // Get month logs for calendar
      (async () => {
        const startOfMonth = new Date(year, month - 1, 1);
        const endOfMonth = new Date(year, month, 0);
        const monthStart = formatDateLocal(startOfMonth);
        const monthEnd = formatDateLocal(endOfMonth);
        return AttendanceLog.query()
          .where('org_id', org_id)
          .where('user_id', user_id)
          .whereBetween('date', [monthStart, monthEnd]);
      })(),
      // Get payroll records
      PayrollRecord.query()
        .where('org_id', org_id)
        .where('user_id', user_id)
        .orderBy('payroll_year', 'desc')
        .orderBy('payroll_month', 'desc')
        .orderBy('created_at', 'desc'),
    ]);

    // Calculate leave summary
    const now = new Date();
    const currentYear = now.getFullYear();
    const { start: yearStart, end: yearEnd } = getYearRange(currentYear);

    const yearLeaves = currentYearLeaves.filter(
      (l) => l.start_date >= yearStart && l.start_date <= yearEnd,
    );

    const userWithDept = userWithRelations as {
      department?: { working_days?: unknown } | null;
    };
    const managedScheduleByManagerId =
      user.role === 'manager'
        ? await fetchPrimaryManagedDepartmentScheduleByManagerIds(org_id, [user_id])
        : undefined;
    const leaveSchedule = resolveLeaveScheduleForRow(
      {
        role: user.role,
        department_id: user.department_id,
        department_working_days: userWithDept.department?.working_days,
        user_id,
      },
      managedScheduleByManagerId,
    );
    const yearHolidaySet = await fetchEffectiveHolidayDateSet(org_id, user_id, yearStart, yearEnd);

    const leaveSummaryByType = new Map<
      string,
      { approved_days: number; pending_days: number; quota: number }
    >();

    for (const leaveType of leaveTypes) {
      leaveSummaryByType.set(leaveType.id, {
        approved_days: 0,
        pending_days: 0,
        quota: leaveType.annual_quota,
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

    // Calculate leave balances
    let allLeavesUsed = 0;
    let allLeavesQuota = 0;
    let paidLeavesUsed = 0;
    let paidLeavesQuota = 0;
    let casualLeavesUsed = 0;
    let casualLeavesQuota = 0;
    let sickLeavesUsed = 0;
    let sickLeavesQuota = 0;

    for (const leaveType of leaveTypes) {
      const typeData = leaveSummaryByType.get(leaveType.id);
      if (typeData) {
        const used = typeData.approved_days;
        const quota = typeData.quota;
        allLeavesUsed += used;
        allLeavesQuota += quota;

        const name = leaveType.name.toLowerCase();
        if (name.includes('paid') || name.includes('annual')) {
          paidLeavesUsed += used;
          paidLeavesQuota += quota;
        } else if (name.includes('casual')) {
          casualLeavesUsed += used;
          casualLeavesQuota += quota;
        } else if (name.includes('sick')) {
          sickLeavesUsed += used;
          sickLeavesQuota += quota;
        }
      }
    }

    // Calculate hours logged for this week
    const weekBreaks = await AttendanceBreak.query()
      .alias('ab')
      .innerJoin('attendance_logs as al', 'al.id', 'ab.attendance_log_id')
      .where('al.org_id', org_id)
      .where('al.user_id', user_id)
      .whereIn(
        'al.date',
        currentWeekLogs.map((l) => l.date),
      )
      .select('ab.attendance_log_id', 'ab.start_time', 'ab.end_time');

    const breaksByLogId = new Map<
      string,
      Array<{ start_time: string; end_time?: string | null }>
    >();
    for (const brk of weekBreaks) {
      const logId = String((brk as any).attendance_log_id);
      if (!breaksByLogId.has(logId)) {
        breaksByLogId.set(logId, []);
      }
      breaksByLogId.get(logId)!.push({
        start_time: (brk as any).start_time,
        end_time: (brk as any).end_time,
      });
    }

    // Helper to calculate work seconds
    const calculateWorkSeconds = (
      clockIn: string | null,
      clockOut: string | null,
      breaks: Array<{ start_time: string; end_time?: string | null }>,
    ): number => {
      if (!clockIn || !clockOut) return 0;
      const start = new Date(clockIn).getTime();
      const end = new Date(clockOut).getTime();
      let breakTime = 0;
      for (const brk of breaks) {
        if (brk.end_time) {
          breakTime += new Date(brk.end_time).getTime() - new Date(brk.start_time).getTime();
        }
      }
      return Math.max(0, Math.floor((end - start - breakTime) / 1000));
    };

    let totalWeekSeconds = 0;
    const dailyHours: Array<{ day: string; hours: number; minutes: number }> = [];
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    for (const log of currentWeekLogs) {
      const breaks = breaksByLogId.get(String((log as any).id)) ?? [];
      const workSeconds = calculateWorkSeconds(
        log.clock_in_time ?? null,
        log.clock_out_time ?? null,
        breaks,
      );
      totalWeekSeconds += workSeconds;
      const date = new Date(log.date);
      const dayName = dayNames[date.getDay()];
      dailyHours.push({
        day: dayName.substring(0, 1), // First letter
        hours: Math.floor(workSeconds / 3600),
        minutes: Math.floor((workSeconds % 3600) / 60),
      });
    }

    const totalHours = Math.floor(totalWeekSeconds / 3600);
    const totalMinutes = Math.floor((totalWeekSeconds % 3600) / 60);

    // Build calendar data
    const startOfMonth = new Date(year, month - 1, 1);
    const endOfMonth = new Date(year, month, 0);
    const monthStart = formatDateLocal(startOfMonth);
    const monthEnd = formatDateLocal(endOfMonth);
    const today = formatDateLocal(new Date());
    const joinDateStr = user.date_of_joining ? formatDateLocal(user.date_of_joining) : null;
    const effectiveStart = joinDateStr && joinDateStr > monthStart ? joinDateStr : monthStart;
    const effectiveEnd = monthEnd;
    const nonFutureEnd = today < monthEnd ? today : monthEnd;

    const monthBreaks = await AttendanceBreak.query()
      .alias('ab')
      .innerJoin('attendance_logs as al', 'al.id', 'ab.attendance_log_id')
      .where('al.org_id', org_id)
      .where('al.user_id', user_id)
      .whereBetween('al.date', [effectiveStart, nonFutureEnd])
      .select('ab.attendance_log_id', 'ab.start_time', 'ab.end_time');

    const monthBreaksByLogId = new Map<
      string,
      Array<{ start_time: string; end_time?: string | null }>
    >();
    for (const brk of monthBreaks) {
      const logId = String((brk as any).attendance_log_id);
      if (!monthBreaksByLogId.has(logId)) {
        monthBreaksByLogId.set(logId, []);
      }
      monthBreaksByLogId.get(logId)!.push({
        start_time: (brk as any).start_time,
        end_time: (brk as any).end_time,
      });
    }

    const monthLeaves = await LeaveRequest.query()
      .where('org_id', org_id)
      .where('user_id', user_id)
      .where('status', 'APPROVED')
      .where((qb) => {
        qb.whereBetween('start_date', [effectiveStart, effectiveEnd])
          .orWhereBetween('end_date', [effectiveStart, effectiveEnd])
          .orWhere((inner) =>
            inner.where('start_date', '<=', effectiveStart).where('end_date', '>=', effectiveEnd),
          );
      });

    const logsByDate = new Map<string, AttendanceLog>();
    for (const log of monthLogs) {
      logsByDate.set(formatDateLocal(log.date), log);
    }

    const leavesByDate = new Set<string>();
    for (const leave of monthLeaves) {
      const start = new Date(leave.start_date);
      const end = new Date(leave.end_date);
      const current = new Date(start);
      while (current <= end) {
        const key = formatDateLocal(current);
        if (key >= effectiveStart && key <= effectiveEnd) {
          leavesByDate.add(key);
        }
        current.setDate(current.getDate() + 1);
      }
    }

    const [holidaySetProfile, scheduleRowProfile] = await Promise.all([
      fetchEffectiveHolidayDateSet(org_id, user_id, monthStart, monthEnd),
      User.query()
        .alias('u')
        .leftJoin('departments as d', 'd.id', 'u.department_id')
        .where('u.id', user_id)
        .where('u.org_id', org_id)
        .select('u.department_id', 'd.working_days as department_working_days')
        .first(),
    ]);

    let profileManagedScheduleFallback:
      | { departmentId: string; workingDays: string[] | null }
      | undefined;
    if (user.role === 'manager') {
      const fbMap = await fetchPrimaryManagedDepartmentScheduleByManagerIds(org_id, [
        String(user_id),
      ]);
      profileManagedScheduleFallback = fbMap.get(String(user_id));
    }
    const effScheduleProfile = resolveEffectiveAttendanceSchedule(
      {
        role: user.role,
        department_id: scheduleRowProfile?.department_id ?? null,
        department_working_days: (scheduleRowProfile as any)?.department_working_days,
      },
      profileManagedScheduleFallback,
    );

    // Build calendar entries
    const calendarEntries: Array<{
      date: string;
      status: 'PRESENT' | 'LATE' | 'LEAVE' | 'ABSENT';
    }> = [];

    let presentCount = 0;
    let lateCount = 0;
    let onLeaveCount = 0;
    let absentCount = 0;

    if (effectiveStart <= effectiveEnd) {
      const cursor = new Date(effectiveStart);
      const effectiveEndDate = new Date(effectiveEnd);
      while (cursor <= effectiveEndDate) {
        const dateKey = formatDateLocal(cursor);

        const logRowProfile = logsByDate.get(dateKey);
        if (
          shouldOmitAttendanceCalendarDate({
            dateStr: dateKey,
            holidaySet: holidaySetProfile,
            departmentId: effScheduleProfile.departmentId,
            workingDays: effScheduleProfile.workingDays,
            hasLog: Boolean(logRowProfile),
            hasPendingCorrection: false,
          })
        ) {
          cursor.setDate(cursor.getDate() + 1);
          continue;
        }

        const log = logRowProfile;
        const isOnLeave = leavesByDate.has(dateKey);
        const isFutureDate = dateKey > today;

        if (isFutureDate && !isOnLeave) {
          cursor.setDate(cursor.getDate() + 1);
          continue;
        }

        if (isOnLeave) {
          calendarEntries.push({ date: dateKey, status: 'LEAVE' });
          onLeaveCount++;
        } else if (log) {
          let isLate = false;
          if (log.clock_in_time) {
            const clockIn = new Date(log.clock_in_time);
            const hours = clockIn.getHours();
            const minutes = clockIn.getMinutes();
            if (hours > 9 || (hours === 9 && minutes > 30)) {
              isLate = true;
            }
          }
          const status = isLate ? 'LATE' : 'PRESENT';
          calendarEntries.push({ date: dateKey, status });
          if (isLate) {
            lateCount++;
          } else {
            presentCount++;
          }
        } else {
          calendarEntries.push({ date: dateKey, status: 'ABSENT' });
          absentCount++;
        }
        cursor.setDate(cursor.getDate() + 1);
      }
    }

    // Format address
    const primaryAddress = addresses.find((a) => a.type === 'PRIMARY') || addresses[0];
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

    // Format documents
    const formattedDocuments = documents.map((doc) => {
      // Extract filename from URL or use doc_type
      const fileName = doc.file_url.split('/').pop() || `${doc.doc_type}.pdf`;
      // Estimate file size (would need actual file size from S3 metadata)
      const fileSize = '1.24 MB'; // Placeholder
      return {
        name: fileName,
        size: fileSize,
        url: doc.file_url,
        category: doc.doc_category,
        type: doc.doc_type,
      };
    });

    // Format join date
    const joinDate = user.date_of_joining
      ? new Date(user.date_of_joining).toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        })
      : null;

    const activeExit = await findActiveExit(org_id, user_id);

    const payrollDisplayList = await resolvePayrollListDisplayAmountsBatch(
      payrollRecords.map((record) => payrollRecordToPayslipPayPeriodInput(record, org_id, user_id)),
    );

    const formatPayrollSummaryDate = (m: number, y: number): string => {
      const monthStr = String(m).padStart(2, '0');
      return `${y}-${monthStr}-01`;
    };

    const payroll_summary =
      payrollRecords.length === 0
        ? {
            total_records: 0,
            latest_payroll: null,
            average_net_salary: 0,
            total_earnings: 0,
            total_deductions: 0,
          }
        : {
            total_records: payrollRecords.length,
            latest_payroll: {
              id: payrollRecords[0].id,
              month: payrollRecords[0].payroll_month,
              year: payrollRecords[0].payroll_year,
              date: formatPayrollSummaryDate(
                payrollRecords[0].payroll_month,
                payrollRecords[0].payroll_year,
              ),
              gross_salary: Number(payrollRecords[0].gross_salary || 0),
              net_salary: payrollDisplayList[0].net_salary,
              total: payrollDisplayList[0].total,
              status: payrollRecords[0].status,
              payslip_url: payrollRecords[0].payslip_pdf_url ?? null,
            },
            average_net_salary: Math.round(
              payrollDisplayList.reduce((sum, d) => sum + d.net_salary, 0) /
                payrollDisplayList.length,
            ),
            total_earnings: payrollDisplayList.reduce((sum, d) => sum + d.payslipNet, 0),
            total_deductions: payrollRecords.reduce(
              (sum, r) => sum + Number(r.total_deductions || 0),
              0,
            ),
          };

    // Build response
    return res.json({
      employee: {
        id: user.id,
        employee_id: user.employee_id,
        full_name: `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim(),
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
        designation: user.designation ?? null,
        department: userWithRelations.department
          ? {
              id: userWithRelations.department.id,
              name: userWithRelations.department.name,
              location_tracking_enabled:
                userWithRelations.department.location_tracking_enabled === true,
            }
          : null,
        status: user.status,
        profile_image_url: (user as any).profile_image_url ?? null,
        location_tracking_enabled: user.location_tracking_enabled ?? null,
      },
      exit: formatExitForProfile(activeExit),
      employment_details: {
        employment_type: employmentDetails?.employment_type ?? null,
        work_mode: employmentDetails?.work_mode ?? null,
        join_date: joinDate,
      },
      social_media: {
        linkedin: null, // Not in current schema
        twitter: null, // Not in current schema
        instagram: null, // Not in current schema
      },
      personal_info: {
        gender: profile?.gender ?? null,
        date_of_birth: profile?.dob
          ? new Date(profile.dob).toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })
          : null,
        email: profile?.personal_email ?? user.official_email,
        phone: profile?.personal_phone ?? null,
        address: formattedAddress,
      },
      leave_summary: {
        all_leaves: {
          used: allLeavesUsed,
          quota: allLeavesQuota,
          percentage: allLeavesQuota > 0 ? Math.round((allLeavesUsed / allLeavesQuota) * 100) : 0,
        },
        paid_leaves: {
          used: paidLeavesUsed,
          quota: paidLeavesQuota,
          percentage:
            paidLeavesQuota > 0 ? Math.round((paidLeavesUsed / paidLeavesQuota) * 100) : 0,
        },
        casual_leaves: {
          used: casualLeavesUsed,
          quota: casualLeavesQuota,
          percentage:
            casualLeavesQuota > 0 ? Math.round((casualLeavesUsed / casualLeavesQuota) * 100) : 0,
        },
        sick_leaves: {
          used: sickLeavesUsed,
          quota: sickLeavesQuota,
          percentage:
            sickLeavesQuota > 0 ? Math.round((sickLeavesUsed / sickLeavesQuota) * 100) : 0,
        },
      },
      hours_logged: {
        total_hours: totalHours,
        total_minutes: totalMinutes,
        total_seconds: totalWeekSeconds,
        daily: dailyHours,
      },
      documents: formattedDocuments,
      calendar: {
        month,
        year,
        entries: calendarEntries,
        legend: {
          present: presentCount,
          late: lateCount,
          on_leave: onLeaveCount,
          absent: absentCount,
        },
      },
      performance_overview: {}, // Empty object as requested
      internal_notes: {}, // Empty object as requested
      payroll_summary,
    });
  }

  static async updateMyPersonalInfo(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const coerceJsonField = <T>(value: unknown, fallback: T): T => {
      if (typeof value !== 'string') return (value as T) ?? fallback;
      const trimmed = value.trim();
      if (!trimmed) return fallback;
      try {
        return JSON.parse(trimmed) as T;
      } catch {
        return fallback;
      }
    };

    const bodyForValidation: any = {
      ...req.body,
      personal_info: coerceJsonField(req.body?.personal_info, req.body?.personal_info),
      bank_details: coerceJsonField(req.body?.bank_details, req.body?.bank_details),
      addresses: coerceJsonField(req.body?.addresses, req.body?.addresses),
      payroll: coerceJsonField(req.body?.payroll, req.body?.payroll),
    };

    const parsed = updatePersonalInfoSchema.safeParse(bodyForValidation);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const user_id = req.user.id;
    const { personal_info, bank_details, addresses, payroll } = parsed.data;

    try {
      let profileImageUrl: string | null | undefined;
      const file = (req as any).file as Express.Multer.File | undefined;
      if (file) {
        if (!env.S3_BUCKET) {
          return res.status(503).json({ message: 'S3 bucket not configured' });
        }

        const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
        if (!allowed.has(file.mimetype)) {
          return res.status(400).json({
            message: 'Profile image must be JPG, PNG, or WEBP.',
          });
        }

        const sanitizeFilename = (name: string): string =>
          name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
        const safeName = sanitizeFilename(file.originalname || 'profile.jpg');
        const key = [
          'orgs',
          req.user.org_id,
          'users',
          user_id,
          'profile',
          `${randomUUID()}-${safeName}`,
        ].join('/');

        const client = getS3Client();
        await client.send(
          new PutObjectCommand({
            Bucket: env.S3_BUCKET,
            Key: key,
            Body: file.buffer,
            ContentType: file.mimetype,
          }),
        );

        profileImageUrl = buildS3PublicUrl(key);
        await User.query().findById(user_id).patch({ profile_image_url: profileImageUrl });
      }

      // Update or create personal info (UserProfile)
      if (personal_info) {
        let profile = await UserProfile.query().findOne({ user_id });

        if (profile) {
          // Update existing profile
          const updateData: any = {};
          if (personal_info.gender !== undefined) updateData.gender = personal_info.gender;
          if (personal_info.marital_status !== undefined)
            updateData.marital_status = personal_info.marital_status;
          if (personal_info.dob !== undefined) updateData.dob = personal_info.dob;
          if (personal_info.nationality !== undefined)
            updateData.nationality = personal_info.nationality;
          if (personal_info.personal_email !== undefined)
            updateData.personal_email = personal_info.personal_email;
          if (personal_info.personal_phone !== undefined)
            updateData.personal_phone = personal_info.personal_phone;
          if (personal_info.alt_phone !== undefined) updateData.alt_phone = personal_info.alt_phone;

          await profile.$query().patch(updateData);
        } else {
          // Create new profile
          await UserProfile.query().insert({
            user_id,
            gender: personal_info.gender,
            marital_status: personal_info.marital_status,
            dob: personal_info.dob,
            nationality: personal_info.nationality,
            personal_email: personal_info.personal_email,
            personal_phone: personal_info.personal_phone,
            alt_phone: personal_info.alt_phone,
          });
        }
      }

      // Update or create bank details
      if (bank_details) {
        let bankDetail = await BankDetail.query().findOne({ user_id });

        if (bankDetail) {
          // Update existing bank detail
          const updateData: any = {};
          if (bank_details.account_holder_name !== undefined)
            updateData.account_holder_name = bank_details.account_holder_name;
          if (bank_details.account_number !== undefined)
            updateData.account_number = bank_details.account_number;
          if (bank_details.ifsc_code !== undefined) updateData.ifsc_code = bank_details.ifsc_code;
          if (bank_details.bank_name !== undefined) updateData.bank_name = bank_details.bank_name;
          if (bank_details.branch_name !== undefined)
            updateData.branch_name = bank_details.branch_name;
          if (bank_details.account_type !== undefined)
            updateData.account_type = bank_details.account_type;

          await bankDetail.$query().patch(updateData);
        } else {
          // Create new bank detail (account_type defaults to 'SALARY' in DB, but we'll use provided value or default)
          await BankDetail.query().insert({
            user_id,
            account_holder_name: bank_details.account_holder_name,
            account_number: bank_details.account_number,
            ifsc_code: bank_details.ifsc_code,
            bank_name: bank_details.bank_name,
            branch_name: bank_details.branch_name,
            account_type: bank_details.account_type ?? 'SALARY', // Default to SALARY if not provided
          });
        }
      }

      if (payroll) {
        const existingPayroll = await UserPayrollDetail.query().findOne({ user_id });
        if (existingPayroll) {
          const patchData: any = {};
          if (payroll.pf_number !== undefined) patchData.pf_number = payroll.pf_number;
          if (payroll.uan_number !== undefined) patchData.uan_number = payroll.uan_number;
          if (Object.keys(patchData).length > 0) {
            await UserPayrollDetail.query().patch(patchData).where({ user_id });
          }
        } else {
          const insertData: any = { user_id };
          if (payroll.pf_number !== undefined) insertData.pf_number = payroll.pf_number;
          if (payroll.uan_number !== undefined) insertData.uan_number = payroll.uan_number;
          if (Object.keys(insertData).length > 1) {
            await UserPayrollDetail.query().insert(insertData);
          }
        }
      }

      // Update addresses
      if (addresses && addresses.length > 0) {
        // Get existing addresses
        const existingAddresses = await Address.query().where({ user_id });
        const existingByType = new Map<string, Address>();
        for (const addr of existingAddresses) {
          existingByType.set(addr.type, addr);
        }

        // Process each address in the request
        for (const addressData of addresses) {
          const existing = existingByType.get(addressData.type);

          if (existing) {
            // Update existing address
            const updateData: any = {};
            if (addressData.street_address !== undefined)
              updateData.street_address = addressData.street_address;
            if (addressData.city !== undefined) updateData.city = addressData.city;
            if (addressData.state !== undefined) updateData.state = addressData.state;
            if (addressData.zip_code !== undefined) updateData.zip_code = addressData.zip_code;
            if (addressData.country !== undefined) updateData.country = addressData.country;

            await existing.$query().patch(updateData);
          } else {
            // Create new address
            await Address.query().insert({
              user_id,
              type: addressData.type,
              street_address: addressData.street_address,
              city: addressData.city,
              state: addressData.state,
              zip_code: addressData.zip_code,
              country: addressData.country,
            });
          }
        }
      }

      // Fetch updated data
      const [updatedProfile, updatedBankDetail, updatedAddresses, updatedPayrollDetail] =
        await Promise.all([
          UserProfile.query().findOne({ user_id }),
          BankDetail.query().findOne({ user_id }),
          Address.query().where({ user_id }),
          UserPayrollDetail.query().findOne({ user_id }),
        ]);

      return res.json({
        message: 'Personal information, bank details, and addresses updated successfully',
        profile_image_url:
          profileImageUrl !== undefined
            ? profileImageUrl
            : (((await User.query().findById(user_id).select('profile_image_url').first()) as any)
                ?.profile_image_url ?? null),
        personal_info: updatedProfile
          ? {
              gender: updatedProfile.gender,
              marital_status: updatedProfile.marital_status,
              dob: updatedProfile.dob,
              nationality: updatedProfile.nationality,
              personal_email: updatedProfile.personal_email,
              personal_phone: updatedProfile.personal_phone,
              alt_phone: updatedProfile.alt_phone,
            }
          : null,
        bank_details: updatedBankDetail
          ? {
              account_holder_name: updatedBankDetail.account_holder_name,
              account_number: updatedBankDetail.account_number,
              ifsc_code: updatedBankDetail.ifsc_code,
              bank_name: updatedBankDetail.bank_name,
              branch_name: updatedBankDetail.branch_name,
              account_type: updatedBankDetail.account_type,
            }
          : null,
        addresses: updatedAddresses.map((addr) => ({
          type: addr.type,
          street_address: addr.street_address,
          city: addr.city,
          state: addr.state,
          zip_code: addr.zip_code,
          country: addr.country,
        })),
        payroll: {
          uan_number: updatedPayrollDetail?.uan_number ?? null,
          pf_number: updatedPayrollDetail?.pf_number ?? null,
        },
      });
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to update personal information',
      });
    }
  }

  static async update(req: Request, res: Response): Promise<Response> {
    if (!req.user) return res.status(401).json({ message: 'Unauthorized' });

    const { userId } = req.params;
    const org_id = req.user.org_id;

    const parsed = updateUserByAdminSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const data = parsed.data;

    try {
      const normalizeEmail = (value: unknown): string | null => {
        if (typeof value !== 'string') return null;
        const trimmed = value.trim();
        if (!trimmed) return null;
        return trimmed.toLowerCase();
      };

      const normalizePhoneLike = (value: unknown): string | null => {
        if (typeof value !== 'string') return null;
        const trimmed = value.trim();
        if (!trimmed) return null;
        return trimmed;
      };

      const officialEmailCandidate =
        'official_email' in data ? normalizeEmail(data.official_email) : null;
      const personalEmailCandidate =
        'personal_email' in data ? normalizeEmail(data.personal_email) : null;
      const personalPhoneCandidate = 'phone' in data ? normalizePhoneLike(data.phone) : null;

      if (officialEmailCandidate) {
        const existing = await User.query()
          .where('org_id', org_id)
          .whereNull('deleted_at')
          .whereRaw('LOWER(official_email) = ?', [officialEmailCandidate])
          .whereNot('id', userId)
          .select('id')
          .first();
        if (existing) {
          return res
            .status(409)
            .json({ field: 'official_email', message: 'Work email already exists' });
        }
      }

      if (personalEmailCandidate) {
        const existing = await UserProfile.query()
          .alias('up')
          .innerJoin('users as u', 'u.id', 'up.user_id')
          .where('u.org_id', org_id)
          .whereNull('u.deleted_at')
          .whereNot('up.user_id', userId)
          .whereRaw('LOWER(up.personal_email) = ?', [personalEmailCandidate])
          .select('up.user_id')
          .first();
        if (existing) {
          return res
            .status(409)
            .json({ field: 'personal_email', message: 'Personal email already exists' });
        }
      }

      if (personalPhoneCandidate) {
        const existing = await UserProfile.query()
          .alias('up')
          .innerJoin('users as u', 'u.id', 'up.user_id')
          .where('u.org_id', org_id)
          .whereNull('u.deleted_at')
          .whereNot('up.user_id', userId)
          .where('up.personal_phone', personalPhoneCandidate)
          .select('up.user_id')
          .first();
        if (existing) {
          return res.status(409).json({ field: 'phone', message: 'Personal phone already exists' });
        }
      }

      const rawEmployeeId =
        'employee_id' in data
          ? data.employee_id
          : 'employeeId' in data
            ? data.employeeId
            : undefined;

      const employeeIdCandidate =
        typeof rawEmployeeId === 'string' && rawEmployeeId.trim() !== ''
          ? rawEmployeeId.trim()
          : null;

      const hasEmployeeIdUpdate = 'employee_id' in data || 'employeeId' in data;

      if (employeeIdCandidate) {
        const existing = await User.query()
          .where('org_id', org_id)
          .whereNull('deleted_at')
          .where('employee_id', employeeIdCandidate)
          .whereNot('id', userId)
          .select('id')
          .first();
        if (existing) {
          return res
            .status(409)
            .json({ field: 'employee_id', message: 'employeeId already exists' });
        }
      }

      const hasEmergencyUpdate =
        data.emergency_contact_name !== undefined ||
        data.emergency_contact_phone !== undefined ||
        data.relation !== undefined;

      if (hasEmergencyUpdate) {
        const existingEmergency = await EmergencyContact.query()
          .where({ user_id: userId })
          .orderBy('is_primary', 'desc')
          .first();
        if (
          !existingEmergency &&
          (!data.emergency_contact_name || !data.emergency_contact_phone || !data.relation)
        ) {
          return res.status(400).json({
            message:
              'emergency_contact_name, emergency_contact_phone, and relation are all required when creating a new emergency contact',
          });
        }
      }

      let locationTrackingChanged = false;
      const updatedUser = await User.transaction(async (trx) => {
        const user = await User.query(trx).findOne({ id: userId, org_id });
        if (!user) throw new Error('Employee not found');

        const userPatch: any = {};
        if ('firstName' in data) userPatch.first_name = data.firstName;
        if ('lastName' in data) userPatch.last_name = data.lastName;
        if ('full_name' in data && data.full_name) {
          userPatch.first_name = data.full_name.split(' ')[0];
          userPatch.last_name = data.full_name.split(' ').slice(1).join(' ');
        }
        if ('official_email' in data) userPatch.official_email = officialEmailCandidate ?? null;
        if (hasEmployeeIdUpdate) {
          userPatch.employee_id = employeeIdCandidate;
        }
        if ('designation' in data) userPatch.designation = data.designation;
        if ('departmentId' in data) userPatch.department_id = data.departmentId;
        if ('join_date' in data) userPatch.date_of_joining = data.join_date;
        if ('location_tracking_enabled' in data) {
          const previousOverride = user.location_tracking_enabled ?? null;
          const nextOverride = data.location_tracking_enabled ?? null;
          userPatch.location_tracking_enabled = data.location_tracking_enabled;
          locationTrackingChanged = previousOverride !== nextOverride;
        }

        if (Object.keys(userPatch).length > 0) {
          await user.$query(trx).patch(userPatch);
        }

        // If a manager's department is set/changed, ensure department_managers has the mapping.
        const effectiveDeptId =
          userPatch.department_id !== undefined
            ? userPatch.department_id
            : (user as any).department_id;
        if ((user as any).role === 'manager' && effectiveDeptId) {
          await DepartmentManager.query(trx)
            .insert({ department_id: String(effectiveDeptId), manager_id: userId } as any)
            .onConflict(['department_id', 'manager_id'])
            .ignore();
        }

        const profilePatch: any = {};
        if ('gender' in data)
          profilePatch.gender =
            data.gender === '' || data.gender === undefined ? null : data.gender;
        if ('date_of_birth' in data) profilePatch.dob = data.date_of_birth || null;
        if ('phone' in data) profilePatch.personal_phone = personalPhoneCandidate ?? null;
        if ('personal_email' in data) profilePatch.personal_email = personalEmailCandidate ?? null;
        if ('blood_group' in data)
          profilePatch.blood_group = data.blood_group === '' ? null : data.blood_group;
        if ('marital_status' in data)
          profilePatch.marital_status = data.marital_status === '' ? null : data.marital_status;
        if ('nationality' in data)
          profilePatch.nationality = data.nationality === '' ? null : data.nationality;

        if (Object.keys(profilePatch).length > 0) {
          const profile = await UserProfile.query(trx).findOne({ user_id: userId });
          if (profile) {
            await profile.$query(trx).patch(profilePatch);
          } else {
            await UserProfile.query(trx).insert({ user_id: userId, ...profilePatch });
          }
        }

        const empPatch: any = {};
        if ('employment_type' in data) {
          empPatch.employment_type =
            typeof data.employment_type === 'string'
              ? data.employment_type === ''
                ? null
                : data.employment_type.toUpperCase()
              : data.employment_type;
        }
        if ('work_mode' in data) {
          empPatch.work_mode =
            typeof data.work_mode === 'string'
              ? data.work_mode === ''
                ? null
                : data.work_mode.toUpperCase()
              : data.work_mode;
        }

        if (Object.keys(empPatch).length > 0) {
          const employment = await EmployeeEmploymentDetail.query(trx).findOne({ user_id: userId });
          if (employment) {
            await employment.$query(trx).patch(empPatch);
          } else {
            await EmployeeEmploymentDetail.query(trx).insert({ user_id: userId, ...empPatch });
          }
        }

        if ('address' in data) {
          // Keep PRESENT and PERMANENT addresses in sync with this "primary" address field.
          const addressTypes: Array<'PRESENT' | 'PERMANENT'> = ['PRESENT', 'PERMANENT'];
          for (const addrType of addressTypes) {
            const existingAddress = await Address.query(trx).findOne({
              user_id: userId,
              type: addrType,
            });
            if (existingAddress) {
              await existingAddress.$query(trx).patch({ street_address: data.address });
            } else {
              await Address.query(trx).insert({
                user_id: userId,
                type: addrType,
                street_address: data.address,
              });
            }
          }
        }

        if (data.permanent_address) {
          const permanentAddressPatch: Record<string, string | null> = {};
          const { permanent_address } = data;

          if ('street' in permanent_address) {
            permanentAddressPatch.street_address =
              permanent_address.street === '' ? null : (permanent_address.street ?? null);
          }
          if ('city' in permanent_address) {
            permanentAddressPatch.city =
              permanent_address.city === '' ? null : (permanent_address.city ?? null);
          }
          if ('state' in permanent_address) {
            permanentAddressPatch.state =
              permanent_address.state === '' ? null : (permanent_address.state ?? null);
          }
          if ('postal_code' in permanent_address) {
            permanentAddressPatch.zip_code =
              permanent_address.postal_code === '' ? null : (permanent_address.postal_code ?? null);
          }
          if ('country' in permanent_address) {
            permanentAddressPatch.country =
              permanent_address.country === '' ? null : (permanent_address.country ?? null);
          }

          if (Object.keys(permanentAddressPatch).length > 0) {
            const existingPermanent = await Address.query(trx).findOne({
              user_id: userId,
              type: 'PERMANENT',
            });

            if (existingPermanent) {
              await existingPermanent.$query(trx).patch(permanentAddressPatch);
            } else {
              await Address.query(trx).insert({
                user_id: userId,
                type: 'PERMANENT',
                street_address: permanentAddressPatch.street_address ?? null,
                city: permanentAddressPatch.city ?? null,
                state: permanentAddressPatch.state ?? null,
                zip_code: permanentAddressPatch.zip_code ?? null,
                country: permanentAddressPatch.country ?? null,
              } as any);
            }
          }
        }

        if (hasEmergencyUpdate) {
          const contact = await EmergencyContact.query(trx)
            .where({ user_id: userId })
            .orderBy('is_primary', 'desc')
            .first();

          const emergencyPatch: Record<string, string> = {};
          if (data.emergency_contact_name !== undefined) {
            emergencyPatch.name = data.emergency_contact_name;
          }
          if (data.emergency_contact_phone !== undefined) {
            emergencyPatch.phone =
              normalizePhoneLike(data.emergency_contact_phone) ?? data.emergency_contact_phone;
          }
          if (data.relation !== undefined) {
            emergencyPatch.relation = data.relation;
          }

          if (contact) {
            if (Object.keys(emergencyPatch).length > 0) {
              await contact.$query(trx).patch(emergencyPatch);
            }
          } else {
            await EmergencyContact.query(trx).insert({
              user_id: userId,
              name: data.emergency_contact_name!,
              phone:
                normalizePhoneLike(data.emergency_contact_phone!) ?? data.emergency_contact_phone!,
              relation: data.relation!,
              is_primary: true,
            });
          }
        }

        return user;
      });

      if (locationTrackingChanged) {
        await invalidateTenantSessionsForUsers(org_id, [userId]);
      }

      // Re-fetch a safe, sanitized view of the user to avoid leaking sensitive fields.
      const safeUser = await User.query()
        .findById(updatedUser.id)
        .select(
          'id',
          'created_at',
          'updated_at',
          'org_id',
          'employee_id',
          'first_name',
          'last_name',
          'official_email',
          'role',
          'status',
          'must_change_password',
          'manager_id',
          'department_id',
          'shift_id',
          'designation',
          'date_of_joining',
          'profile_image_url',
          'location_tracking_enabled',
          'deleted_at',
        );

      // Also include updated date_of_birth so the PATCH response reflects the change.
      // Note: user_profiles.dob is a DATE column, which can map to a Date/string depending on pg parsing.
      const profile = await UserProfile.query().findOne({ user_id: updatedUser.id });
      const formattedDob = profile?.dob
        ? typeof profile.dob === 'string'
          ? profile.dob
          : (() => {
              const dateVal = new Date(profile.dob as any);
              if (Number.isNaN(dateVal.getTime())) return null;
              const y = dateVal.getFullYear();
              const m = String(dateVal.getMonth() + 1).padStart(2, '0');
              const d = String(dateVal.getDate()).padStart(2, '0');
              return `${y}-${m}-${d}`;
            })()
        : null;

      syncAdminHrFullForUserIfApplicable({
        userId,
        orgId: org_id,
      }).catch((err) => {
        logger.error({ err, userId, org_id }, 'Failed to sync admin/hr user update across orgs');
      });

      return res.status(200).json({
        message: 'Updated successfully',
        user: {
          ...safeUser,
          date_of_birth: formattedDob,
        },
      });
    } catch (error: any) {
      logger.error({ err: error }, 'Failed to update personal info');
      return res
        .status(error.message === 'Employee not found' ? 404 : 500)
        .json({ message: error.message });
    }
  }

  /**
   * Clone/sync an admin or HR from their first org into the current org by email.
   * Admin targets may sync when source onboarding is pending; HR requires COMPLETED.
   */
  static async crossOrgSync(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const role = typeof req.body?.role === 'string' ? req.body.role.trim().toLowerCase() : '';

    if (!email) {
      return res.status(400).json({ message: 'email is required' });
    }
    if (role !== 'admin' && role !== 'hr') {
      return res.status(400).json({ message: 'role must be admin or hr' });
    }

    try {
      const result = await ensureAndCloneAdminHrFromEmail({
        email,
        role,
        targetOrgId: req.user.org_id,
      });

      return res.status(result.created ? 201 : 200).json({
        message: result.created
          ? 'Admin/HR user created and cloned from source organization'
          : 'Admin/HR user data cloned from source organization',
        cloned: result.cloned,
        created: result.created,
        user_id: result.user_id,
        password_reused: result.password_reused,
        source_org_id: result.source_org_id,
        onboarding_status: result.onboarding_status,
        role: result.role,
      });
    } catch (err) {
      if (
        err instanceof AdminHrCrossOrgEligibilityError ||
        err instanceof AdminHrCrossOrgNotFoundError ||
        err instanceof AdminHrCrossOrgConflictError
      ) {
        return res.status(err.statusCode).json({ message: err.message });
      }
      logger.error({ err, email, role }, 'Failed cross-org admin/hr sync');
      return res.status(500).json({ message: 'Failed to sync admin/hr across organizations' });
    }
  }

  static async updateEmployeePayrollFinance(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { userId } = req.params;
    const org_id = req.user.org_id;

    const parsed = editEmployeePayrollFinanceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { apply_from, finance } = parsed.data;

    const targetUser = await User.query()
      .where('org_id', org_id)
      .where('id', userId)
      .whereNull('deleted_at')
      .select('id', 'org_id')
      .first();

    if (!targetUser) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const now = new Date();
    const effectiveFrom =
      apply_from === 'CURRENT_MONTH'
        ? new Date(now.getFullYear(), now.getMonth(), 1)
        : new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const result = await applyEmployeePayrollFinanceUpdate({
      userId,
      org_id,
      finance,
      effective_from: effectiveFrom,
      sync_current_month: apply_from === 'CURRENT_MONTH',
    });

    syncAdminHrFullForUserIfApplicable({
      userId,
      orgId: org_id,
    }).catch((err) => {
      logger.error({ err, userId, org_id }, 'Failed to sync admin/hr payroll finance across orgs');
    });

    return res.json({
      message: 'Employee payroll finance updated successfully',
      data: {
        user_id: userId,
        apply_from,
        salary_structure_id: result.salary_structure_id,
        effective_from: result.effective_from.toISOString(),
        annual_ctc: result.annual_ctc,
      },
    });
  }

  static async getEmployeePayrollFinance(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { userId } = req.params;
    const org_id = req.user.org_id;

    const targetUser = await User.query()
      .where('org_id', org_id)
      .where('id', userId)
      .whereNull('deleted_at')
      .select('id')
      .first();

    if (!targetUser) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const employment = await EmployeeEmploymentDetail.query().findOne({ user_id: userId });
    const annual_ctc = Number((employment as any)?.annual_ctc ?? 0) || 0;

    const structure = await SalaryStructure.query()
      .where('org_id', org_id)
      .where('user_id', userId)
      .whereNull('deleted_at')
      .where('is_active', true)
      .orderBy('effective_from', 'desc')
      .first();

    if (!structure) {
      return res.json({
        user_id: userId,
        payroll_info: { annual_ctc },
        earnings: {
          basic_salary: 0,
          hra: 0,
          other_allowance: 0,
          gross_earnings: 0,
        },
        deductions: {
          pf: 0,
          professional_tax: 0,
          total_deductions: 0,
        },
        net_payable: {
          salary_per_month: 0,
        },
        employer_contributions: {
          pf: 0,
          total_contributions: 0,
        },
      });
    }

    const breakdown = (structure as any).component_breakdown ?? {};
    const componentIds = Object.keys(breakdown).filter((id) => id);
    const comps =
      componentIds.length > 0
        ? await SalaryComponent.query()
            .where('org_id', org_id)
            .whereNull('deleted_at')
            .whereIn('id', componentIds)
            .select('id', 'code', 'name', 'type')
        : [];
    const metaById = new Map<string, { code: string; name: string; type: string }>(
      (comps as any[]).map((c) => [
        String(c.id),
        {
          code: String(c.code || '').toUpperCase(),
          name: String(c.name || '').trim(),
          type: String(c.type || '').toUpperCase(),
        },
      ]),
    );

    const getMonthlyByCode = (code: string): number => {
      const target = code.toUpperCase();
      for (const [id, amount] of Object.entries(breakdown)) {
        if (metaById.get(String(id))?.code === target) {
          const n = Number(amount ?? 0);
          return Number.isFinite(n) ? n : 0;
        }
      }
      return 0;
    };

    const basicMonthly = getMonthlyByCode('BASIC');
    const hraMonthly = getMonthlyByCode('HRA');
    const otherAllowanceMonthly = getMonthlyByCode('OTHER_ALLOWANCE');

    const money = UserController.sanitizeMoney;

    const pfMonthly = getMonthlyByCode('PF');
    const profTaxMonthly = getMonthlyByCode('PROFESSIONAL_TAX');

    // Derive totals from the structure breakdown when possible (includes dynamic items).
    let earningsSum = 0;
    let deductionsSum = 0;
    for (const [id, amount] of Object.entries(breakdown)) {
      const meta = metaById.get(String(id));
      if (!meta) continue;
      const monthly = Number(amount ?? 0);
      if (!Number.isFinite(monthly) || monthly <= 0) continue;
      if (meta.type === 'DEDUCTION') deductionsSum += monthly;
      else if (['EARNING', 'ALLOWANCE', 'BONUS', 'OVERTIME', 'INCENTIVE'].includes(meta.type))
        earningsSum += monthly;
    }
    const grossMonthly = Number((structure as any).gross_salary ?? 0) || money(earningsSum) || 0;
    const totalDeductionsMonthly = money(deductionsSum) || money(pfMonthly + profTaxMonthly);
    const salaryPerMonth =
      Number((structure as any).net_salary ?? 0) || money(grossMonthly - totalDeductionsMonthly);
    const annualInt = (monthlyAmount: number): number => Math.round(money(monthlyAmount) * 12);
    const annualCtcInt = Math.round(money(annual_ctc));

    const knownCodes = new Set(['BASIC', 'HRA', 'OTHER_ALLOWANCE', 'PF', 'PROFESSIONAL_TAX']);

    const dynamicEarningsItems: Array<{ name: string; amount: number }> = [];
    const dynamicDeductionsItems: Array<{ name: string; amount: number }> = [];

    for (const [id, amount] of Object.entries(breakdown)) {
      const meta = metaById.get(String(id));
      if (!meta) continue;
      if (knownCodes.has(meta.code)) continue;
      const monthly = Number(amount ?? 0);
      if (!Number.isFinite(monthly) || monthly <= 0) continue;

      const item = { name: meta.name || meta.code, amount: annualInt(monthly) };
      if (meta.type === 'DEDUCTION') {
        dynamicDeductionsItems.push(item);
      } else if (['EARNING', 'ALLOWANCE', 'BONUS', 'OVERTIME', 'INCENTIVE'].includes(meta.type)) {
        dynamicEarningsItems.push(item);
      }
    }

    const employerAnnualTotal = Number((structure as any).employer_total_contributions ?? 0) || 0;
    // Current data model persists only a single employer contribution total (annual).
    // For now, expose it as PF as well since PF is the only employer contribution we track.
    const employerAnnualPf = employerAnnualTotal;

    return res.json({
      user_id: userId,
      payroll_info: { annual_ctc: annualCtcInt },
      earnings: {
        basic_salary: annualInt(basicMonthly),
        hra: annualInt(hraMonthly),
        other_allowance: annualInt(otherAllowanceMonthly),
        gross_earnings: annualInt(grossMonthly),
      },
      deductions: {
        pf: annualInt(pfMonthly),
        professional_tax: annualInt(profTaxMonthly),
        total_deductions: annualInt(totalDeductionsMonthly),
      },
      net_payable: {
        salary_per_month: money(salaryPerMonth),
      },
      employer_contributions: {
        pf: employerAnnualPf,
        total_contributions: employerAnnualTotal,
      },
      meta: {
        salary_structure_id: (structure as any).id,
        effective_from: (structure as any).effective_from,
        earnings_items: dynamicEarningsItems,
        deductions_items: dynamicDeductionsItems,
      },
    });
  }
}
