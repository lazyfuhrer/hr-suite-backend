import { EmployeeEmploymentDetail } from '../models/EmployeeEmploymentDetail';
import { PayrollRecord } from '../models/PayrollRecord';
import { SalaryComponent } from '../models/SalaryComponent';
import { SalaryStructure } from '../models/SalaryStructure';
import { ensureFinanceItemComponent, normalizeFinanceItems } from '../utils/finance-items.utils';
import { generateCurrentMonthPayrollForUser } from './auto-payroll.service';
import { AdminPayrollController } from '../controllers/tenant/admin-payroll.controller';

function sanitizeMoney(input: number): number {
  if (!Number.isFinite(input)) return 0;
  return Math.round(input * 100) / 100;
}

export interface ApplyEmployeePayrollFinanceUpdateParams {
  userId: string;
  org_id: string;
  finance: any;
  effective_from: Date;
  hike_percentage?: number;
  sync_current_month: boolean;
}

export interface ApplyEmployeePayrollFinanceUpdateResult {
  salary_structure_id: string;
  annual_ctc: number;
  effective_from: Date;
}

export async function applyEmployeePayrollFinanceUpdate(
  params: ApplyEmployeePayrollFinanceUpdateParams,
): Promise<ApplyEmployeePayrollFinanceUpdateResult> {
  const { userId, org_id, finance, effective_from, hike_percentage, sync_current_month } = params;

  const money = sanitizeMoney;
  const { payroll_info, earnings, earnings_items, deductions, deductions_items, net_payable } =
    finance;

  // All values in the payload are ANNUAL except salary_per_month which is monthly
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

  const basic_salary = money(annual_basic_salary / 12);
  const hra = money(annual_hra / 12);
  const other_allowance = money(annual_other_allowance / 12);
  const gross_earnings = money(annual_gross_earnings / 12);
  const pf = money(annual_pf / 12);
  const professional_tax = money(annual_professional_tax / 12);
  const total_deductions = money(annual_total_deductions / 12);

  const salary_per_month = money(
    net_payable?.salary_per_month ?? gross_earnings - total_deductions,
  );

  const ensureComponent = async (
    trx: any,
    input: {
      code: string;
      name: string;
      type: SalaryComponent['type'];
      display_order: number;
      is_taxable?: boolean;
      is_pf_applicable?: boolean;
      is_esi_applicable?: boolean;
    },
  ): Promise<SalaryComponent> => {
    const existing = await SalaryComponent.query(trx)
      .where({ org_id, code: input.code })
      .whereNull('deleted_at')
      .first();
    if (existing) return existing as SalaryComponent;

    return (await SalaryComponent.query(trx).insert({
      org_id,
      code: input.code,
      name: input.name,
      type: input.type,
      display_order: input.display_order,
      is_taxable: input.is_taxable ?? true,
      is_pf_applicable: input.is_pf_applicable ?? false,
      is_esi_applicable: input.is_esi_applicable ?? false,
      is_active: true,
    })) as SalaryComponent;
  };

  const computeBucketsFromStructure = async (trx: any, structure: SalaryStructure) => {
    const componentIds = Object.keys(structure.component_breakdown || {}).filter((id) => id);
    const components =
      componentIds.length > 0
        ? await SalaryComponent.query(trx)
            .where({ org_id })
            .whereNull('deleted_at')
            .whereIn('id', componentIds)
            .select('id', 'type', 'code')
        : [];

    let totalEarnings = 0;
    let totalDeductions = 0;
    let pfContribution = 0;
    let professionalTax = 0;

    for (const comp of components as any[]) {
      const amount = Number(structure.component_breakdown?.[comp.id] ?? 0);
      if (!Number.isFinite(amount) || amount <= 0) continue;

      if (['EARNING', 'ALLOWANCE', 'BONUS', 'OVERTIME', 'INCENTIVE'].includes(comp.type)) {
        totalEarnings += amount;
      } else if (comp.type === 'DEDUCTION') {
        totalDeductions += amount;
        const code = String(comp.code || '').toUpperCase();
        if (code === 'PF') pfContribution += amount;
        else if (code === 'PROFESSIONAL_TAX') professionalTax += amount;
      }
    }

    return {
      totalEarnings: money(totalEarnings),
      totalDeductions: money(totalDeductions),
      pfContribution: money(pfContribution),
      professionalTax: money(professionalTax),
    };
  };

  const newStructure = await EmployeeEmploymentDetail.transaction(async (trx) => {
    const [basicComp, hraComp, otherAllowComp, pfComp, profTaxComp] = await Promise.all([
      ensureComponent(trx, {
        code: 'BASIC',
        name: 'Basic Salary',
        type: 'EARNING',
        display_order: 10,
      }),
      ensureComponent(trx, {
        code: 'HRA',
        name: 'House Rent Allowance',
        type: 'ALLOWANCE',
        display_order: 20,
      }),
      ensureComponent(trx, {
        code: 'OTHER_ALLOWANCE',
        name: 'Other Allowance',
        type: 'ALLOWANCE',
        display_order: 30,
      }),
      ensureComponent(trx, {
        code: 'PF',
        name: 'Provident Fund (PF)',
        type: 'DEDUCTION',
        display_order: 110,
        is_taxable: false,
        is_pf_applicable: true,
      }),
      ensureComponent(trx, {
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
          return (await SalaryComponent.query(t).insert({
            ...input,
            is_taxable: true,
            is_pf_applicable: false,
            is_esi_applicable: false,
            is_active: true,
          })) as any;
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
          return (await SalaryComponent.query(t).insert({
            ...input,
            is_taxable: false,
            is_pf_applicable: false,
            is_esi_applicable: false,
            is_active: true,
          })) as any;
        },
      });

      component_breakdown[String((comp as any).id)] = money(Number(item.amount) / 12);
    }

    await SalaryStructure.query(trx)
      .where({ user_id: userId, org_id, is_active: true })
      .whereNull('deleted_at')
      .patch({ is_active: false });

    const inserted = (await SalaryStructure.query(trx).insert({
      org_id,
      user_id: userId,
      effective_from,
      gross_salary: gross_earnings,
      net_salary: salary_per_month,
      employer_total_contributions: Number(
        finance?.employer_contributions?.total_contributions ?? 0,
      ),
      component_breakdown,
      notes: 'employee_payroll_finance_edit',
      hike_percentage,
      is_active: true,
    })) as SalaryStructure;

    await EmployeeEmploymentDetail.query(trx)
      .insert({
        user_id: userId,
        base_salary: basic_salary,
        annual_ctc,
      })
      .onConflict('user_id')
      .merge({
        base_salary: basic_salary,
        annual_ctc,
      });

    return inserted;
  });

  if (sync_current_month) {
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();
    const existing = await PayrollRecord.query()
      .where('org_id', org_id)
      .where('user_id', userId)
      .where('payroll_month', month)
      .where('payroll_year', year)
      .first();

    if (!existing) {
      await generateCurrentMonthPayrollForUser(userId, org_id);
    } else if (existing.status !== 'CANCELLED') {
      // Update the existing record to match the new structure.
      // Requirement: even if payroll is PAID, edits to payroll finance should reflect in
      // payroll list APIs and in the downloaded/stored payslip.
      const buckets = await computeBucketsFromStructure(PayrollRecord.knex(), newStructure);
      const grossSalary = Number(newStructure.gross_salary || 0) || buckets.totalEarnings || 0;

      // Preserve previously-adjusted deductions captured in `adjustment_extra_deductions`.
      // If PF/PT are present there, treat them as overrides for the statutory columns.
      // Keep non-statutory items (e.g., LOP) as "Other Deductions" on top of statutory totals.
      const existingExtra = Array.isArray((existing as any).adjustment_extra_deductions)
        ? ((existing as any).adjustment_extra_deductions as Array<{
            name: string;
            amount: number;
          }>)
        : [];
      const norm = (raw: string): string =>
        String(raw || '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .trim();
      const isPf = (n: string): boolean => n === 'pf' || n.includes('provident fund');
      const isPt = (n: string): boolean =>
        n === 'pt' || n.includes('professional tax') || n.includes('profession tax');
      const findOverride = (predicate: (n: string) => boolean): number | null => {
        for (const item of existingExtra) {
          const n = norm((item as any)?.name);
          if (!n) continue;
          if (predicate(n)) {
            const amt = Number((item as any)?.amount || 0);
            return Number.isFinite(amt) ? amt : 0;
          }
        }
        return null;
      };
      const pfOverride = findOverride(isPf);
      const ptOverride = findOverride(isPt);

      const nonStatutoryExtra = existingExtra
        .filter((i) => {
          const n = norm((i as any)?.name);
          if (!n) return false;
          return !(isPf(n) || isPt(n));
        })
        .reduce((sum, i) => sum + Number((i as any).amount || 0), 0);

      const nextPf = money(pfOverride ?? buckets.pfContribution);
      const nextProfessionalTax = money(ptOverride ?? buckets.professionalTax);

      const nextTotalDeductions = money(nextPf + nextProfessionalTax + nonStatutoryExtra);
      const nextNetSalary = money(money(grossSalary) - nextTotalDeductions);
      const netSalaryFromRequest = money(salary_per_month);
      const willUseRequestNetSalary = Boolean(
        net_payable && (net_payable as any).salary_per_month !== undefined,
      );
      const netSalaryToPersist = willUseRequestNetSalary ? netSalaryFromRequest : nextNetSalary;

      const willPatchPaid = existing.status === 'PAID';

      await PayrollRecord.query()
        .findById(existing.id)
        .patch({
          salary_structure_id: newStructure.id,
          gross_salary: money(grossSalary),
          total_earnings: money(buckets.totalEarnings || grossSalary),
          total_deductions: nextTotalDeductions,
          net_salary: netSalaryToPersist,
          pf_contribution: nextPf,
          professional_tax: nextProfessionalTax,
          component_breakdown: newStructure.component_breakdown,
          adjustment_extra_deductions: existingExtra as any,
          payslip_pdf_url: willPatchPaid ? (existing as any).payslip_pdf_url : undefined,
        });

      if (willPatchPaid) {
        await AdminPayrollController.regeneratePayslipPdfUrlForRecord(org_id, existing.id);
      }
    }
  }

  return {
    salary_structure_id: newStructure.id,
    annual_ctc,
    effective_from,
  };
}
