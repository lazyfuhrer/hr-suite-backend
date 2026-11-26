import { SalaryComponent } from '../models/SalaryComponent';
import { computePayslipAttendanceMetrics } from './payslip-attendance-metrics.utils';

export const SALARY_MONTH_DAYS = 30;

export function lopPayFactorFromLopDays(lopDays: number): number {
  const lop = Math.min(Math.max(0, Number(lopDays) || 0), SALARY_MONTH_DAYS);
  return (SALARY_MONTH_DAYS - lop) / SALARY_MONTH_DAYS;
}

const EARNING_TYPES = ['EARNING', 'ALLOWANCE', 'BONUS', 'OVERTIME', 'INCENTIVE'];

type EarningSource =
  | 'component'
  | 'gross_basic'
  | 'overtime'
  | 'incentive'
  | 'bonus'
  | 'allowance'
  | 'other'
  | 'adjustment_incentive';

function normalizeEarningLabel(s: string): string {
  return s.trim().toLowerCase();
}

function isLopProratedEarningSource(source: EarningSource): boolean {
  return source === 'component' || source === 'gross_basic' || source === 'other';
}

type InternalEarningRow = { label: string; earned: number; source: EarningSource };

function reconcileEarningRowsToTarget(rows: InternalEarningRow[], targetTotal: number): void {
  const sum = rows.reduce((s, row) => s + row.earned, 0);
  const delta = Number((targetTotal - sum).toFixed(2));
  if (Math.abs(delta) <= 0.01 || rows.length === 0) return;
  const otherIdx = rows.findIndex((row) => normalizeEarningLabel(row.label) === 'other earnings');
  const idx = otherIdx >= 0 ? otherIdx : rows.length - 1;
  rows[idx].earned = Number((rows[idx].earned + delta).toFixed(2));
}

/**
 * Builds earning rows like the payslip PDF (always includes an Other Earnings line).
 */
async function buildPayslipEarningRows(
  record: PayslipPayPeriodRecordInput,
): Promise<{ rows: InternalEarningRow[]; lopPayFactor: number }> {
  const metrics = await computePayslipAttendanceMetrics({
    orgId: record.orgId,
    userId: record.userId,
    payrollMonth: record.payrollMonth,
    payrollYear: record.payrollYear,
  });
  const lopPayFactor = lopPayFactorFromLopDays(metrics.lopDays);

  const breakdown = record.component_breakdown || {};
  const componentIds = Object.keys(breakdown).filter((id) => id && id.trim());
  const comps =
    componentIds.length > 0
      ? await SalaryComponent.query().where('org_id', record.orgId).whereIn('id', componentIds)
      : [];

  const components = comps.map((comp) => ({
    component: comp,
    amount: Number(breakdown[comp.id] || 0),
  }));

  const earningRows: InternalEarningRow[] = [];
  const hasEarningLabel = new Set<string>();
  let earningComponentTotal = 0;

  const pushEarning = (label: string, monthlyAmount: number, source: EarningSource) => {
    const normalized = normalizeEarningLabel(label);
    if (!normalized || hasEarningLabel.has(normalized)) return;
    const monthly = Number(monthlyAmount || 0);
    hasEarningLabel.add(normalized);
    earningRows.push({ label, earned: monthly, source });
    earningComponentTotal += monthly;
  };

  const earningComponents = components
    .filter((c) => EARNING_TYPES.includes(c.component.type))
    .sort((a, b) => (a.component.display_order || 0) - (b.component.display_order || 0));

  earningComponents.forEach(({ component, amount }) => {
    pushEarning(component.name, amount, 'component');
  });

  if (!hasEarningLabel.has('basic salary') && Number(record.gross_salary || 0) > 0) {
    pushEarning('Basic Salary', Number(record.gross_salary || 0), 'gross_basic');
  }

  const adjustmentIncentives = Array.isArray(record.adjustment_incentives)
    ? record.adjustment_incentives
    : [];
  const adjustmentIncentiveSum = adjustmentIncentives.reduce(
    (sum, inc) => sum + Number(inc?.amount || 0),
    0,
  );
  const useColumnVariablePay = adjustmentIncentives.length === 0;

  const specialEarnings: Array<[string, number, EarningSource]> = useColumnVariablePay
    ? [
        ['Overtime', Number(record.overtime_amount || 0), 'overtime'],
        ['Incentive', Number(record.incentive_amount || 0), 'incentive'],
        ['Bonus', Number(record.bonus_amount || 0), 'bonus'],
        ['Allowance', Number(record.allowance_amount || 0), 'allowance'],
      ]
    : [['Allowance', Number(record.allowance_amount || 0), 'allowance']];
  specialEarnings.forEach(([label, amount, src]) => {
    if (amount > 0) pushEarning(label, amount, src);
  });

  const adjustmentIncentiveByLabel = new Map<string, number>();
  for (const inc of adjustmentIncentives) {
    const name = String(inc?.name || '').trim();
    const amt = Number(inc?.amount || 0);
    if (!name || !Number.isFinite(amt) || amt === 0) continue;
    const key = normalizeEarningLabel(name);
    adjustmentIncentiveByLabel.set(key, (adjustmentIncentiveByLabel.get(key) || 0) + amt);
  }
  for (const [key, amt] of adjustmentIncentiveByLabel) {
    const displayName =
      adjustmentIncentives
        .find((i) => normalizeEarningLabel(String(i.name || '').trim()) === key)
        ?.name?.trim() || key;
    pushEarning(displayName, amt, 'adjustment_incentive');
  }

  const totalEarningsFromRecord = Number(record.total_earnings || 0);
  const structuralEarningsTarget = Number(
    (totalEarningsFromRecord - adjustmentIncentiveSum).toFixed(2),
  );
  const otherResidual = Number((structuralEarningsTarget - earningComponentTotal).toFixed(2));
  pushEarning('Other Earnings', otherResidual, 'other');

  if (metrics.lopDays > 0 && lopPayFactor < 1) {
    for (const row of earningRows) {
      if (!isLopProratedEarningSource(row.source)) continue;
      row.earned = Number((row.earned * lopPayFactor).toFixed(2));
    }
  }

  return { rows: earningRows, lopPayFactor };
}

/**
 * Other Earnings earned for one period, matching payslip PDF (LOP + reconcile).
 * Used for FY prior-month YTD on the Other Earnings line.
 */
export async function computeOtherEarningsEarnedForPeriod(
  record: PayslipPayPeriodRecordInput,
): Promise<number> {
  const { rows } = await buildPayslipEarningRows(record);
  const totals = await computePayslipPayPeriodTotals(record);
  reconcileEarningRowsToTarget(rows, totals.earningsTotal);
  const otherRow = rows.find((r) => normalizeEarningLabel(r.label) === 'other earnings');
  const otherEarned = otherRow ? otherRow.earned : 0;
  const adjustmentEarned = rows
    .filter((r) => r.source === 'adjustment_incentive')
    .reduce((sum, r) => sum + r.earned, 0);
  // When reconcile leaves a positive Other line, it already includes the structural gap;
  // only add adjustments when Other is zero (amount shown on that line after PDF compress).
  if (Math.abs(otherEarned) > 0.01) {
    return Number(otherEarned.toFixed(2));
  }
  return Number(adjustmentEarned.toFixed(2));
}

export type PayslipPayPeriodRecordInput = {
  orgId: string;
  userId: string;
  payrollMonth: number;
  payrollYear: number;
  gross_salary: number;
  total_earnings: number;
  total_deductions: number;
  pf_contribution?: number | null;
  professional_tax?: number | null;
  overtime_amount?: number | null;
  incentive_amount?: number | null;
  bonus_amount?: number | null;
  allowance_amount?: number | null;
  component_breakdown: Record<string, number>;
  adjustment_incentives?: Array<{ name: string; amount: number }>;
  adjustment_extra_deductions?: Array<{ name: string; amount: number }>;
};

export type PayslipPayPeriodTotals = {
  earningsTotal: number;
  deductionsTotal: number;
  /** Same as payslip PDF NET SALARY PAYABLE. */
  payslipNet: number;
  lopPayFactor: number;
  lopDays: number;
};

/**
 * Mirrors payslip PDF earning/deduction row math (including per-line LOP rounding).
 */
export async function computePayslipPayPeriodTotals(
  record: PayslipPayPeriodRecordInput,
): Promise<PayslipPayPeriodTotals> {
  const metrics = await computePayslipAttendanceMetrics({
    orgId: record.orgId,
    userId: record.userId,
    payrollMonth: record.payrollMonth,
    payrollYear: record.payrollYear,
  });
  const lopPayFactor = lopPayFactorFromLopDays(metrics.lopDays);

  const breakdown = record.component_breakdown || {};
  const componentIds = Object.keys(breakdown).filter((id) => id && id.trim());
  const comps =
    componentIds.length > 0
      ? await SalaryComponent.query().where('org_id', record.orgId).whereIn('id', componentIds)
      : [];

  const components = comps.map((comp) => ({
    component: comp,
    amount: Number(breakdown[comp.id] || 0),
  }));

  type EarningRow = { earned: number; source: EarningSource };
  const earningRows: EarningRow[] = [];
  const hasEarningLabel = new Set<string>();
  let earningComponentTotal = 0;

  const pushEarning = (label: string, monthlyAmount: number, source: EarningSource) => {
    const normalized = normalizeEarningLabel(label);
    if (!normalized || hasEarningLabel.has(normalized)) return;
    const monthly = Number(monthlyAmount || 0);
    hasEarningLabel.add(normalized);
    earningRows.push({ earned: monthly, source });
    earningComponentTotal += monthly;
  };

  const earningComponents = components
    .filter((c) => EARNING_TYPES.includes(c.component.type))
    .sort((a, b) => (a.component.display_order || 0) - (b.component.display_order || 0));

  earningComponents.forEach(({ component, amount }) => {
    pushEarning(component.name, amount, 'component');
  });

  if (!hasEarningLabel.has('basic salary') && Number(record.gross_salary || 0) > 0) {
    pushEarning('Basic Salary', Number(record.gross_salary || 0), 'gross_basic');
  }

  const adjustmentIncentives = Array.isArray(record.adjustment_incentives)
    ? record.adjustment_incentives
    : [];
  const adjustmentIncentiveSum = adjustmentIncentives.reduce(
    (sum, inc) => sum + Number(inc?.amount || 0),
    0,
  );
  // After payroll adjustment, incentive/overtime/bonus columns mirror adjustment_incentives;
  // pushing both double-counts (total_earnings already includes adjustment incentives).
  const useColumnVariablePay = adjustmentIncentives.length === 0;

  const specialEarnings: Array<[string, number, EarningSource]> = useColumnVariablePay
    ? [
        ['Overtime', Number(record.overtime_amount || 0), 'overtime'],
        ['Incentive', Number(record.incentive_amount || 0), 'incentive'],
        ['Bonus', Number(record.bonus_amount || 0), 'bonus'],
        ['Allowance', Number(record.allowance_amount || 0), 'allowance'],
      ]
    : [['Allowance', Number(record.allowance_amount || 0), 'allowance']];
  specialEarnings.forEach(([label, amount, src]) => {
    if (amount > 0) pushEarning(label, amount, src);
  });
  const adjustmentIncentiveByLabel = new Map<string, number>();
  for (const inc of adjustmentIncentives) {
    const name = String(inc?.name || '').trim();
    const amt = Number(inc?.amount || 0);
    if (!name || !Number.isFinite(amt) || amt === 0) continue;
    const key = normalizeEarningLabel(name);
    adjustmentIncentiveByLabel.set(key, (adjustmentIncentiveByLabel.get(key) || 0) + amt);
  }
  for (const [key, amt] of adjustmentIncentiveByLabel) {
    const displayName =
      adjustmentIncentives
        .find((i) => normalizeEarningLabel(String(i.name || '').trim()) === key)
        ?.name?.trim() || key;
    pushEarning(displayName, amt, 'adjustment_incentive');
  }

  const totalEarningsFromRecord = Number(record.total_earnings || 0);
  const structuralEarningsTarget = Number(
    (totalEarningsFromRecord - adjustmentIncentiveSum).toFixed(2),
  );
  const otherResidual = Number((structuralEarningsTarget - earningComponentTotal).toFixed(2));
  if (otherResidual > 0.01) {
    pushEarning('Other Earnings', otherResidual, 'other');
  }

  if (metrics.lopDays > 0 && lopPayFactor < 1) {
    for (const row of earningRows) {
      if (!isLopProratedEarningSource(row.source)) continue;
      row.earned = Number((row.earned * lopPayFactor).toFixed(2));
    }
  }

  const earningsTotal = earningRows.reduce((sum, row) => sum + row.earned, 0);

  type DeductionRow = { amount: number };
  const deductionRows: DeductionRow[] = [];
  const hasDeductionLabel = new Set<string>();

  const pushDeduction = (label: string, amount: number) => {
    const normalized = label.trim().toLowerCase();
    if (!normalized || hasDeductionLabel.has(normalized)) return;
    hasDeductionLabel.add(normalized);
    deductionRows.push({ amount: Number(amount || 0) });
  };

  components
    .filter((c) => c.component.type === 'DEDUCTION')
    .forEach(({ component, amount }) => pushDeduction(component.name, amount));

  if (
    Number(record.pf_contribution || 0) > 0 &&
    !hasDeductionLabel.has('provident fund') &&
    !hasDeductionLabel.has('provident fund (pf)')
  ) {
    pushDeduction('Provident Fund', Number(record.pf_contribution || 0));
  }
  if (
    Number(record.professional_tax || 0) > 0 &&
    !hasDeductionLabel.has('professional tax') &&
    !hasDeductionLabel.has('professional tax (pt)') &&
    !hasDeductionLabel.has('profession tax')
  ) {
    pushDeduction('Professional Tax', Number(record.professional_tax || 0));
  }

  const adjustmentExtraDeductions = Array.isArray(record.adjustment_extra_deductions)
    ? record.adjustment_extra_deductions
    : [];
  const norm = (s: string): string =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const isPf = (n: string): boolean => n === 'pf' || n.includes('provident fund');
  const isPt = (n: string): boolean =>
    n === 'pt' || n.includes('professional tax') || n.includes('profession tax');
  for (const d of adjustmentExtraDeductions) {
    const name = String(d?.name || '').trim();
    const amount = Number(d?.amount || 0);
    if (!name || !Number.isFinite(amount) || amount === 0) continue;
    const n = norm(name);
    if (isPf(n) || isPt(n)) continue;
    pushDeduction(name, amount);
  }

  const totalDeductionsFromRecord = Number(record.total_deductions || 0);
  const deductionRowsTotal = deductionRows.reduce((s, row) => s + row.amount, 0);
  if (totalDeductionsFromRecord - deductionRowsTotal > 0.01) {
    pushDeduction('Other Deductions', totalDeductionsFromRecord - deductionRowsTotal);
  }

  const deductionsTotal = deductionRows.reduce((s, row) => s + row.amount, 0);
  const payslipNet = Number((earningsTotal - deductionsTotal).toFixed(2));

  return {
    earningsTotal,
    deductionsTotal,
    payslipNet,
    lopPayFactor,
    lopDays: metrics.lopDays,
  };
}
