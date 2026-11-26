import { Model } from 'objection';
import { UniqueViolationError } from 'db-errors';

import { logger } from '../config/logger';
import { formatDateLocal } from '../utils/date.utils';
import { PayrollRecord } from '../models/PayrollRecord';
import { SalaryComponent } from '../models/SalaryComponent';
import { SalaryStructure } from '../models/SalaryStructure';
import { User } from '../models/User';

interface GenerateMonthlyPayrollOptions {
  /**
   * Reference date used to determine the payroll month/year.
   * If not provided, current server date is used.
   *
   * We intentionally generate payroll for the **previous** calendar month
   * (e.g. if today is 2026‑03‑01, we generate payroll for 2026‑02).
   */
  referenceDate?: Date;
}

interface ComponentBuckets {
  totalEarnings: number;
  totalDeductions: number;
  pfContribution: number;
  professionalTax: number;
}

function istCalendarYearMonth(now: Date = new Date()): { year: number; month: number } {
  const s = formatDateLocal(now);
  return {
    year: Number(s.slice(0, 4)),
    month: Number(s.slice(5, 7)),
  };
}

/**
 * True when a payroll row for (payrollYear, payrollMonth) may be auto-created:
 * strictly before the IST current calendar month (not the in-progress month, not the future).
 * Manual admin inserts bypass this by not using createPayrollRecordFromStructure.
 */
export function canAutoCreatePayrollForPeriodInIST(
  payrollMonth: number,
  payrollYear: number,
  now: Date = new Date(),
): boolean {
  const { year: cy, month: cm } = istCalendarYearMonth(now);
  if (payrollYear > cy || (payrollYear === cy && payrollMonth > cm)) return false;
  if (payrollYear === cy && payrollMonth === cm) return false;
  return true;
}

/** Payroll period for batch job: calendar month immediately before IST date of reference. */
function computeTargetMonthYear(referenceDate?: Date): { month: number; year: number } {
  const now = referenceDate ? new Date(referenceDate) : new Date();
  const { year: y, month: m } = istCalendarYearMonth(now);
  let month = m - 1;
  let year = y;
  if (month < 1) {
    month = 12;
    year -= 1;
  }
  return { month, year };
}

async function bucketizeComponents(salaryStructure: SalaryStructure): Promise<ComponentBuckets> {
  const componentIds = Object.keys(salaryStructure.component_breakdown || {});
  if (componentIds.length === 0) {
    return {
      totalEarnings: 0,
      totalDeductions: 0,
      pfContribution: 0,
      professionalTax: 0,
    };
  }

  const components = await SalaryComponent.query()
    .whereIn('id', componentIds)
    .where({ org_id: salaryStructure.org_id })
    .whereNull('deleted_at');

  const buckets: ComponentBuckets = {
    totalEarnings: 0,
    totalDeductions: 0,
    pfContribution: 0,
    professionalTax: 0,
  };

  for (const component of components) {
    const amount = Number(salaryStructure.component_breakdown[component.id] || 0);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    if (['EARNING', 'ALLOWANCE', 'BONUS', 'OVERTIME', 'INCENTIVE'].includes(component.type)) {
      buckets.totalEarnings += amount;
    } else if (component.type === 'DEDUCTION') {
      buckets.totalDeductions += amount;

      const code = (component.code || '').toUpperCase();
      if (code === 'PF') {
        buckets.pfContribution += amount;
      } else if (code === 'PROFESSIONAL_TAX') {
        buckets.professionalTax += amount;
      }
    }
  }

  return buckets;
}

async function createPayrollRecordFromStructure(params: {
  userId: string;
  orgId: string;
  month: number;
  year: number;
  salaryStructure: SalaryStructure;
}): Promise<void> {
  const { userId, orgId, month, year, salaryStructure } = params;

  if (!canAutoCreatePayrollForPeriodInIST(month, year)) {
    logger.info(
      {
        user_id: userId,
        org_id: orgId,
        payroll_month: month,
        payroll_year: year,
        ist_today: formatDateLocal(new Date()),
      },
      'Skipping payroll auto-create: period is future or IST in-progress month',
    );
    return;
  }

  const buckets = await bucketizeComponents(salaryStructure);

  const grossSalary = Number(salaryStructure.gross_salary || 0) || buckets.totalEarnings || 0;
  const netSalary =
    Number(salaryStructure.net_salary || 0) || grossSalary - buckets.totalDeductions;

  await Model.transaction(async (trx) => {
    await PayrollRecord.query(trx).insert({
      org_id: orgId,
      user_id: userId,
      payroll_month: month,
      payroll_year: year,
      salary_structure_id: salaryStructure.id,
      gross_salary: grossSalary,
      total_earnings: buckets.totalEarnings || grossSalary,
      total_deductions: buckets.totalDeductions,
      net_salary: netSalary,
      pf_contribution: buckets.pfContribution || null,
      professional_tax: buckets.professionalTax || null,
      overtime_amount: 0,
      incentive_amount: 0,
      bonus_amount: 0,
      allowance_amount: 0,
      component_breakdown: salaryStructure.component_breakdown || {},
      status: 'PENDING',
    } as Partial<PayrollRecord>);

    // Do NOT generate or upload payslip here. Payslips are generated only
    // when the payroll record is explicitly processed/marked as PAID via
    // the existing admin endpoints, preserving the previous flow.
  });
}

/**
 * Generate monthly payroll records for all active employees based on their
 * latest salary structure (which is populated via onboarding finance APIs).
 *
 * For each (user, month, year) combination this function is **idempotent**:
 * if a payroll record already exists, it is left as‑is and not recreated.
 *
 * This function only creates payroll records in PENDING status. Payslips are
 * generated later when the record is processed or marked as PAID.
 */
export async function generateMonthlyPayrollForAllEmployees(
  options: GenerateMonthlyPayrollOptions = {},
): Promise<void> {
  const { month, year } = computeTargetMonthYear(options.referenceDate);

  logger.info(
    { payroll_month: month, payroll_year: year },
    'Starting automatic monthly payroll generation',
  );

  // Fetch all active users; we only generate payrolls for active employees
  const users = await User.query().where('status', 'ACTIVE');

  if (users.length === 0) {
    logger.info('No active users found, skipping automatic payroll generation');
    return;
  }

  for (const user of users) {
    // Safety: org_id should always be present, but skip if not
    if (!user.org_id) {
      continue;
    }

    try {
      // Skip if payroll record for this month/year already exists (idempotent)
      const existingRecord = await PayrollRecord.query()
        .where('user_id', user.id)
        .where('org_id', user.org_id)
        .where('payroll_month', month)
        .where('payroll_year', year)
        .first();

      if (existingRecord) {
        continue;
      }

      // Get latest active salary structure for this user as of the payroll month
      const payrollPeriodEnd = new Date(year, month, 0); // last day of target month
      const salaryStructure = await SalaryStructure.query()
        .where('user_id', user.id)
        .where('org_id', user.org_id)
        .whereNull('deleted_at')
        .where('effective_from', '<=', payrollPeriodEnd)
        .where((qb) => {
          qb.whereNull('effective_to').orWhere('effective_to', '>=', payrollPeriodEnd);
        })
        .orderBy('effective_from', 'desc')
        .first();

      if (!salaryStructure) {
        // If no salary structure, we cannot auto‑generate payroll for this user
        logger.warn(
          { user_id: user.id, org_id: user.org_id },
          'Skipping automatic payroll: no active salary structure',
        );
        continue;
      }

      await createPayrollRecordFromStructure({
        userId: user.id,
        orgId: user.org_id,
        month,
        year,
        salaryStructure,
      });
    } catch (error) {
      logger.error(
        {
          err: error,
          user_id: user.id,
          org_id: user.org_id,
          payroll_month: month,
          payroll_year: year,
        },
        'Failed to automatically generate payroll for user',
      );
    }
  }

  logger.info(
    { payroll_month: month, payroll_year: year },
    'Completed automatic monthly payroll generation',
  );
}

/**
 * Generate payroll for the **IST current calendar month** for a single user based on their
 * latest active salary structure (e.g. after onboarding finance).
 *
 * Does nothing while that month is still in progress in IST: records appear from the
 * **next** IST month onward (same rule as ensurePayroll / scheduler). Idempotent.
 */
export async function generateCurrentMonthPayrollForUser(
  userId: string,
  orgId: string,
): Promise<void> {
  const now = new Date();
  const { year, month } = istCalendarYearMonth(now);

  if (!canAutoCreatePayrollForPeriodInIST(month, year, now)) {
    logger.info(
      { user_id: userId, org_id: orgId, payroll_month: month, payroll_year: year },
      'Skipping current-month payroll: IST calendar month still in progress or future',
    );
    return;
  }

  // Idempotency check
  const existing = await PayrollRecord.query()
    .where('user_id', userId)
    .where('org_id', orgId)
    .where('payroll_month', month)
    .where('payroll_year', year)
    .first();

  if (existing) {
    return;
  }

  // Use the latest active salary structure (the one just created/updated by onboarding finance)
  const salaryStructure = await SalaryStructure.query()
    .where('user_id', userId)
    .where('org_id', orgId)
    .whereNull('deleted_at')
    .where('is_active', true)
    .orderBy('effective_from', 'desc')
    .first();

  if (!salaryStructure) {
    logger.warn(
      { user_id: userId, org_id: orgId },
      'Skipping current month payroll generation: no active salary structure',
    );
    return;
  }

  try {
    await createPayrollRecordFromStructure({
      userId,
      orgId,
      month,
      year,
      salaryStructure,
    });
  } catch (error) {
    if (error instanceof UniqueViolationError) {
      return;
    }
    logger.error(
      { err: error, user_id: userId, org_id: orgId, payroll_month: month, payroll_year: year },
      'Failed to generate current month payroll for user',
    );
  }
}

/**
 * Ensure payroll records exist for a specific month/year for all ACTIVE users
 * in an organization. Creates missing records from salary structure.
 *
 * Skips the **IST in-progress** calendar month and future months (no auto-heal for current month).
 * Idempotent and safe to call from read paths for **past** months only in practice.
 */
export async function ensurePayrollForMonthForOrganization(
  orgId: string,
  month: number,
  year: number,
): Promise<void> {
  const now = new Date();
  const { year: cy, month: cm } = istCalendarYearMonth(now);
  if (year > cy || (year === cy && month > cm)) {
    return;
  }
  if (year === cy && month === cm) {
    logger.info(
      { org_id: orgId, payroll_month: month, payroll_year: year },
      'ensurePayrollForMonthForOrganization: skipping IST in-progress month',
    );
    return;
  }

  const users = await User.query()
    .where('org_id', orgId)
    .where('status', 'ACTIVE')
    .whereNull('deleted_at');

  if (users.length === 0) return;

  const payrollPeriodEnd = new Date(year, month, 0);

  for (const user of users) {
    try {
      const existingRecord = await PayrollRecord.query()
        .where('user_id', user.id)
        .where('org_id', orgId)
        .where('payroll_month', month)
        .where('payroll_year', year)
        .first();

      if (existingRecord) continue;

      const salaryStructure = await SalaryStructure.query()
        .where('user_id', user.id)
        .where('org_id', orgId)
        .whereNull('deleted_at')
        .where('effective_from', '<=', payrollPeriodEnd)
        .where((qb) => {
          qb.whereNull('effective_to').orWhere('effective_to', '>=', payrollPeriodEnd);
        })
        .orderBy('effective_from', 'desc')
        .first();

      if (!salaryStructure) continue;

      await createPayrollRecordFromStructure({
        userId: user.id,
        orgId,
        month,
        year,
        salaryStructure,
      });
    } catch (error) {
      if (error instanceof UniqueViolationError) {
        continue;
      }
      logger.error(
        { err: error, user_id: user.id, org_id: orgId, payroll_month: month, payroll_year: year },
        'Failed to ensure payroll record for user and month',
      );
    }
  }
}

export type EnsurePayrollForUserMonthResult = {
  status: 'created' | 'skipped' | 'blocked';
  payroll_record_id?: string;
  message: string;
  /** True when payroll was created from latest active structure because month window had no match. */
  usedLatestActiveStructureFallback?: boolean;
};

/**
 * Create a missing PENDING payroll row for one user/month from their effective salary structure.
 * Same rules as ensurePayrollForMonthForOrganization (IST past months only; not future/in-progress).
 *
 * @param useLatestActiveSalaryStructure When true, if no structure matches the payroll month window,
 *   uses the latest **active** structure for the user (dev/simulation only — amounts may not match history).
 */
export async function ensurePayrollRecordForUserMonth(params: {
  orgId: string;
  userId: string;
  month: number;
  year: number;
  useLatestActiveSalaryStructure?: boolean;
}): Promise<EnsurePayrollForUserMonthResult> {
  const { orgId, userId, useLatestActiveSalaryStructure } = params;
  const m = Math.min(12, Math.max(1, Number(params.month)));
  const y = Number(params.year);

  if (!canAutoCreatePayrollForPeriodInIST(m, y)) {
    return {
      status: 'blocked',
      message:
        'Payroll auto-create is not allowed for an IST future or in-progress month. Use admin manual POST /api/payroll/admin/records or wait until that month is past in IST.',
    };
  }

  const user = await User.query()
    .findById(userId)
    .where('org_id', orgId)
    .where('status', 'ACTIVE')
    .whereNull('deleted_at')
    .first();

  if (!user) {
    return { status: 'skipped', message: 'User not found, inactive, deleted, or org_id mismatch.' };
  }

  const existingRecord = await PayrollRecord.query()
    .where('user_id', userId)
    .where('org_id', orgId)
    .where('payroll_month', m)
    .where('payroll_year', y)
    .first();

  if (existingRecord) {
    return {
      status: 'skipped',
      payroll_record_id: existingRecord.id,
      message: 'Payroll record already exists for this user and month.',
    };
  }

  const payrollPeriodEnd = new Date(y, m, 0);

  let salaryStructure = await SalaryStructure.query()
    .where('user_id', userId)
    .where('org_id', orgId)
    .whereNull('deleted_at')
    .where('effective_from', '<=', payrollPeriodEnd)
    .where((qb) => {
      qb.whereNull('effective_to').orWhere('effective_to', '>=', payrollPeriodEnd);
    })
    .orderBy('effective_from', 'desc')
    .first();

  let usedLatestActiveStructureFallback = false;

  if (!salaryStructure && useLatestActiveSalaryStructure) {
    salaryStructure = await SalaryStructure.query()
      .where('user_id', userId)
      .where('org_id', orgId)
      .whereNull('deleted_at')
      .where('is_active', true)
      .orderBy('effective_from', 'desc')
      .first();
    if (salaryStructure) {
      usedLatestActiveStructureFallback = true;
    }
  }

  if (!salaryStructure) {
    return {
      status: 'skipped',
      message: useLatestActiveSalaryStructure
        ? 'No salary structure for this month, and no latest active structure found (--use-latest-salary-structure).'
        : 'No salary structure effective for this month. Ensure effective_from is on/before month end and effective_to is open or after month end, or pass --use-latest-salary-structure for dev fallback.',
    };
  }

  try {
    await createPayrollRecordFromStructure({
      userId,
      orgId,
      month: m,
      year: y,
      salaryStructure,
    });
    const created = await PayrollRecord.query()
      .where('user_id', userId)
      .where('org_id', orgId)
      .where('payroll_month', m)
      .where('payroll_year', y)
      .first();
    return {
      status: 'created',
      payroll_record_id: created?.id,
      message: usedLatestActiveStructureFallback
        ? 'Payroll record created from latest active salary structure (month window did not match; dev fallback).'
        : 'Payroll record created from salary structure.',
      usedLatestActiveStructureFallback,
    };
  } catch (error) {
    if (error instanceof UniqueViolationError) {
      const again = await PayrollRecord.query()
        .where('user_id', userId)
        .where('org_id', orgId)
        .where('payroll_month', m)
        .where('payroll_year', y)
        .first();
      return {
        status: 'skipped',
        payroll_record_id: again?.id,
        message: 'Payroll record already existed (unique conflict).',
      };
    }
    throw error;
  }
}
