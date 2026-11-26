import {
  computePayslipPayPeriodTotals,
  type PayslipPayPeriodRecordInput,
} from './payslip-pay-period-totals.utils';

export { SALARY_MONTH_DAYS, lopPayFactorFromLopDays } from './payslip-pay-period-totals.utils';
export type { PayslipPayPeriodRecordInput } from './payslip-pay-period-totals.utils';

export type PayrollListDisplayAmounts = {
  net_salary: number;
  total: number;
  incentives: number;
  deductions: number;
  lopPayFactor: number;
  payslipNet: number;
};

function sumAdjustmentAmounts(
  items: Array<{ name?: string; amount?: number }> | undefined,
): number {
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum, item) => sum + Number(item?.amount || 0), 0);
}

/** Map a payroll DB row into payslip-aligned list input. */
export function payrollRecordToPayslipPayPeriodInput(
  record: {
    payroll_month: number;
    payroll_year: number;
    gross_salary?: number | string | null;
    total_earnings?: number | string | null;
    total_deductions?: number | string | null;
    pf_contribution?: number | string | null;
    professional_tax?: number | string | null;
    overtime_amount?: number | string | null;
    incentive_amount?: number | string | null;
    bonus_amount?: number | string | null;
    allowance_amount?: number | string | null;
    component_breakdown?: Record<string, number> | null;
    adjustment_incentives?: Array<{ name: string; amount: number }> | null;
    adjustment_extra_deductions?: Array<{ name: string; amount: number }> | null;
  },
  orgId: string,
  userId: string,
): PayslipPayPeriodRecordInput {
  return {
    orgId,
    userId,
    payrollMonth: Number(record.payroll_month),
    payrollYear: Number(record.payroll_year),
    gross_salary: Number(record.gross_salary || 0),
    total_earnings: Number(record.total_earnings || 0),
    total_deductions: Number(record.total_deductions || 0),
    pf_contribution: record.pf_contribution != null ? Number(record.pf_contribution) : null,
    professional_tax: record.professional_tax != null ? Number(record.professional_tax) : null,
    overtime_amount: record.overtime_amount != null ? Number(record.overtime_amount) : null,
    incentive_amount: record.incentive_amount != null ? Number(record.incentive_amount) : null,
    bonus_amount: record.bonus_amount != null ? Number(record.bonus_amount) : null,
    allowance_amount: record.allowance_amount != null ? Number(record.allowance_amount) : null,
    component_breakdown: (record.component_breakdown || {}) as Record<string, number>,
    adjustment_incentives: Array.isArray(record.adjustment_incentives)
      ? record.adjustment_incentives
      : [],
    adjustment_extra_deductions: Array.isArray(record.adjustment_extra_deductions)
      ? record.adjustment_extra_deductions
      : [],
  };
}

/**
 * List API amounts aligned with payslip PDF (per-line LOP proration).
 * - `net_salary`: payslip NET before adjustment incentives/deductions
 * - `incentives` / `deductions`: adjustment JSON sums
 * - `total`: net_salary + incentives - deductions (= payslip NET SALARY PAYABLE)
 */
export async function resolvePayrollListDisplayAmounts(
  record: PayslipPayPeriodRecordInput,
): Promise<PayrollListDisplayAmounts> {
  const incentives = sumAdjustmentAmounts(record.adjustment_incentives);
  const deductions = sumAdjustmentAmounts(record.adjustment_extra_deductions);

  const period = await computePayslipPayPeriodTotals(record);
  const payslipNet = period.payslipNet;
  const net_salary = Number((payslipNet - incentives + deductions).toFixed(2));
  const total = Number((net_salary + incentives - deductions).toFixed(2));

  return {
    net_salary,
    total,
    incentives,
    deductions,
    lopPayFactor: period.lopPayFactor,
    payslipNet,
  };
}

export async function resolvePayrollListDisplayAmountsBatch(
  records: PayslipPayPeriodRecordInput[],
): Promise<PayrollListDisplayAmounts[]> {
  return Promise.all(records.map((r) => resolvePayrollListDisplayAmounts(r)));
}
