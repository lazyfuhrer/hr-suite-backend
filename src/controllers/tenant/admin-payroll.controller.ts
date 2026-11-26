import type { Request, Response } from 'express';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import multer from 'multer';
import * as XLSX from 'xlsx';
import crypto from 'crypto';

import { PayrollRecord } from '../../models/PayrollRecord';
import { SalaryComponent } from '../../models/SalaryComponent';
import { SalaryStructure } from '../../models/SalaryStructure';
import { PayrollUpload } from '../../models/PayrollUpload';
import { User } from '../../models/User';
import { Organization } from '../../models/Organization';
import { OrgPayrollSetting } from '../../models/OrgPayrollSetting';
import { EmployeeEmploymentDetail } from '../../models/EmployeeEmploymentDetail';
import { AttendanceLog } from '../../models/AttendanceLog';
import { logger } from '../../config/logger';
import { getS3Client, buildS3PublicUrl } from '../../utils/s3';
import { getManagedDepartmentIds } from '../../utils/department-manager.utils';
import { formatDateLocal } from '../../utils/date.utils';
import {
  fetchEffectiveHolidayDateSetsForUsers,
  fetchOrgHolidayDateSet,
  isUserAttendanceScheduledDay,
} from '../../utils/attendance-schedule.utils';
import { computeMonthlyShiftBasedOvertimeHours } from '../../utils/attendance-overtime.utils';
import { computePayslipAttendanceMetrics } from '../../utils/payslip-attendance-metrics.utils';
import {
  payrollRecordToPayslipPayPeriodInput,
  resolvePayrollListDisplayAmounts,
  resolvePayrollListDisplayAmountsBatch,
} from '../../utils/payroll-list-display.utils';
import { env } from '../../config/env';
import { PayslipPdfService } from '../../services/payslip-pdf.service';
import {
  ensurePayrollForMonthForOrganization,
  generateCurrentMonthPayrollForUser,
} from '../../services/auto-payroll.service';
import {
  computePayrollSettingsBreakdown,
  normalizeOrgPayrollSetting,
} from '../../services/payroll-settings.service';
import {
  createSalaryComponentSchema,
  updateSalaryComponentSchema,
  createSalaryStructureSchema,
  updateSalaryStructureSchema,
  payrollRecordsListQuerySchema,
  payrollListQuerySchema,
  createPayrollRecordSchema,
  updatePayrollRecordSchema,
  payrollUploadQuerySchema,
  payrollDashboardSummaryQuerySchema,
  payrollAdjustmentUpdateSchema,
  upsertOrgPayrollSettingsSchema,
  payrollSettingsPreviewQuerySchema,
} from '../../validators';

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    if (
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.mimetype === 'application/vnd.ms-excel' ||
      file.mimetype === 'application/pdf'
    ) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only Excel and PDF files are allowed.'));
    }
  },
});

export class AdminPayrollController {
  private static isFuturePayrollPeriod(
    month: number,
    year: number,
    now: Date = new Date(),
  ): boolean {
    const nowMonth = now.getMonth() + 1;
    const nowYear = now.getFullYear();
    return year > nowYear || (year === nowYear && month > nowMonth);
  }

  static async downloadPayrollExcel(req: Request, res: Response): Promise<Response | void> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = payrollListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const {
      month,
      year,
      start_date,
      end_date,
      from_date,
      to_date,
      user_id,
      status,
      search,
      sort_by,
      sort_dir,
    } = parsed.data;

    const rangeFrom = from_date ?? start_date;
    const rangeTo = to_date ?? end_date;
    const org_id = req.user.org_id;
    const isManager = req.user.role === 'manager';

    const hasMonthYear = month !== undefined && year !== undefined;
    const hasFromTo = Boolean(rangeFrom) && Boolean(rangeTo);
    if (!hasMonthYear && !hasFromTo) {
      return res.status(400).json({
        message: 'Either month & year, or from_date & to_date are required for Excel download',
      });
    }

    try {
      if (month && year) {
        if (AdminPayrollController.isFuturePayrollPeriod(month, year)) {
          // Future payroll should not be generated or shown until that period arrives.
          // For exports, return an empty file (baseQuery will return zero rows).
        } else {
          await ensurePayrollForMonthForOrganization(org_id, month, year);
        }
      }

      let managedDepartmentIds: string[] = [];
      if (isManager) {
        managedDepartmentIds = await getManagedDepartmentIds(org_id, req.user.id);
      }

      const organization = await Organization.query().findById(org_id);
      if (!organization) {
        return res.status(404).json({ message: 'Organization not found' });
      }

      const baseQuery = PayrollRecord.query()
        .alias('pr')
        .leftJoin('users as u', 'u.id', 'pr.user_id')
        .leftJoin('departments as d', 'd.id', 'u.department_id')
        .leftJoin('user_payroll_details as upd', 'upd.user_id', 'pr.user_id')
        .leftJoin('bank_details as bd', 'bd.user_id', 'pr.user_id')
        .leftJoin('salary_structures as ss', 'ss.id', 'pr.salary_structure_id')
        .leftJoin('user_identities as ui_aadhaar', (join) => {
          join
            .on('ui_aadhaar.user_id', '=', 'pr.user_id')
            .onVal('ui_aadhaar.id_type', '=', 'AADHAAR');
        })
        .where('pr.org_id', org_id)
        .whereNull('u.deleted_at')
        .modify((qb) => {
          if (isManager) {
            qb.whereIn('u.department_id', managedDepartmentIds).where('u.role', 'employee');
          }
        });

      if (month && year) {
        baseQuery.where('pr.payroll_month', month).where('pr.payroll_year', year);
      }
      if (user_id) {
        baseQuery.where('pr.user_id', user_id);
      }
      if (status) {
        baseQuery.where('pr.status', status);
      }
      if (rangeFrom && rangeTo) {
        baseQuery.whereRaw(
          'make_date(pr.payroll_year, pr.payroll_month, 1) between ?::date and ?::date',
          [rangeFrom, rangeTo],
        );
      }

      if (search) {
        const term = `%${search}%`;
        baseQuery.where((qb) => {
          qb.where('u.first_name', 'ilike', term)
            .orWhere('u.last_name', 'ilike', term)
            .orWhere('u.employee_id', 'ilike', term)
            .orWhere('u.official_email', 'ilike', term)
            .orWhereRaw("CONCAT(u.first_name, ' ', u.last_name) ILIKE ?", [term]);
        });
      }

      // IMPORTANT: remove ORDER BY for count(*) query (Postgres errors otherwise)
      const countRow = await baseQuery.clone().clearOrder().count('* as count').first();
      const total = Number((countRow as { count?: string | number } | undefined)?.count ?? 0);
      const MAX_EXPORT_ROWS = 10_000;
      if (total > MAX_EXPORT_ROWS) {
        return res.status(400).json({
          message: `Too many rows to export (${total}). Please narrow the filters (max ${MAX_EXPORT_ROWS}).`,
        });
      }

      if (sort_by === 'NAME') {
        baseQuery.orderBy('u.first_name', sort_dir === 'DESC' ? 'desc' : 'asc');
        baseQuery.orderBy('u.last_name', sort_dir === 'DESC' ? 'desc' : 'asc');
      } else if (sort_by === 'JOB_TITLE') {
        baseQuery.orderBy('u.designation', sort_dir === 'DESC' ? 'desc' : 'asc');
      } else if (sort_by === 'SALARY') {
        baseQuery.orderBy('pr.gross_salary', sort_dir === 'DESC' ? 'desc' : 'asc');
      } else if (sort_by === 'TOTAL') {
        const direction = sort_dir === 'DESC' ? 'DESC' : 'ASC';
        baseQuery.orderByRaw(
          `COALESCE(pr.gross_salary, 0) + COALESCE(pr.allowance_amount, 0) + COALESCE(pr.overtime_amount, 0) + COALESCE(pr.incentive_amount, 0) - COALESCE(pr.total_deductions, 0) ${direction}`,
        );
      } else if (sort_by === 'STATUS') {
        baseQuery.orderBy('pr.status', sort_dir === 'DESC' ? 'desc' : 'asc');
      } else {
        baseQuery.orderBy('pr.payroll_year', 'desc');
        baseQuery.orderBy('pr.payroll_month', 'desc');
        baseQuery.orderBy('pr.created_at', 'desc');
      }
      baseQuery.orderBy('pr.created_at', 'desc');

      const rows = await baseQuery
        .clone()
        .select(
          'pr.id',
          'pr.user_id',
          'pr.payroll_month',
          'pr.payroll_year',
          'pr.gross_salary',
          'pr.total_earnings',
          'pr.total_deductions',
          'pr.net_salary',
          'pr.pf_contribution',
          'pr.professional_tax',
          'pr.incentive_amount',
          'pr.bonus_amount',
          'pr.allowance_amount',
          'pr.component_breakdown',
          'u.employee_id',
          'u.first_name',
          'u.last_name',
          'u.designation',
          'upd.pf_number',
          'upd.esi_number',
          'upd.pan_number',
          'bd.bank_name',
          'bd.account_number',
          'bd.ifsc_code',
          'd.name as department_name',
          'd.working_days as department_working_days',
          'u.department_id as department_id',
          'ss.employer_total_contributions as employer_total_contributions',
          'ui_aadhaar.id_number as aadhaar_number',
        );

      if (month && year && AdminPayrollController.isFuturePayrollPeriod(month, year)) {
        // Hide future payroll even if records exist.
        rows.splice(0, rows.length);
      }

      const reportFrom = (() => {
        if (rangeFrom) return rangeFrom;
        if (month && year) return `${year}-${String(month).padStart(2, '0')}-01`;
        return '';
      })();

      const reportTo = (() => {
        if (rangeTo) return rangeTo;
        if (month && year) {
          const lastDay = new Date(year, month, 0).getDate();
          return `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
        }
        return '';
      })();

      const workbook = XLSX.utils.book_new();
      const headerRows: any[][] = [
        [organization.name || ''],
        [organization.address || ''],
        [`Email: ${organization.contact_email || ''}`],
        [`Contact: ${organization.phone_number || ''}`],
        [`Date: ${formatDateLocal(new Date())}`],
        ['Payroll Report'],
        [`Report Period: (${reportFrom} - ${reportTo})`],
        [],
        [
          'Sl. No',
          'Emp.ID',
          'Employee Name',
          'PF No.',
          'ESI No.',
          'PAN No.',
          'Bank Name',
          'Bank A/c No.',
          'IFSC',
          'Job Title',
          'Department',
          'Aadhaar No.',
          'Pay Days',
          'Present Days',
          'CTC',
          'BASIC',
          'HRA',
          'SPECIAL AL',
          'Standard A',
          'Others',
          'BONUS',
          'Arrears',
          'Total Earnings',
          'ESI',
          'PF',
          'PT',
          'TDS',
          'Salary Advance',
          'Others',
          'Total Deductions',
          'Net Amount',
        ],
      ];

      const uniqueUserIds = Array.from(new Set(rows.map((r: any) => String(r.user_id)))).filter(
        Boolean,
      );

      const holidaySet =
        reportFrom && reportTo
          ? await fetchOrgHolidayDateSet(org_id, reportFrom, reportTo)
          : new Set<string>();
      const holidaySetByUserId =
        uniqueUserIds.length > 0 && reportFrom && reportTo
          ? await fetchEffectiveHolidayDateSetsForUsers(org_id, uniqueUserIds, reportFrom, reportTo)
          : new Map<string, Set<string>>();

      const presentDaysByUserId = new Map<string, number>();
      if (uniqueUserIds.length > 0 && reportFrom && reportTo) {
        const presentRows = await AttendanceLog.query()
          .alias('al')
          .where('al.org_id', org_id)
          .whereBetween('al.date', [reportFrom, reportTo])
          .whereIn('al.user_id', uniqueUserIds)
          .groupBy('al.user_id')
          .select('al.user_id')
          .countDistinct('al.date as present_days');
        for (const prRow of presentRows as any[]) {
          presentDaysByUserId.set(String(prRow.user_id), Number(prRow.present_days ?? 0));
        }
      }

      const componentIdSet = new Set<string>();
      for (const r of rows as any[]) {
        const breakdown = (r as any).component_breakdown ?? {};
        for (const k of Object.keys(breakdown || {})) {
          if (k && String(k).trim().length > 0) componentIdSet.add(String(k));
        }
      }
      const componentIds = Array.from(componentIdSet);
      const components =
        componentIds.length > 0
          ? await SalaryComponent.query().whereIn('id', componentIds).select('id', 'code', 'type')
          : [];
      const compById = new Map<string, { code: string; type: string }>();
      for (const c of components as any[]) {
        compById.set(String(c.id), {
          code: String(c.code ?? '').toUpperCase(),
          type: String(c.type ?? '').toUpperCase(),
        });
      }

      const getBreakdownAmountByCodes = (
        breakdown: Record<string, any>,
        codes: string[],
      ): number => {
        const codeSet = new Set(codes.map((c) => c.toUpperCase()));
        let sum = 0;
        for (const [compId, amount] of Object.entries(breakdown || {})) {
          const meta = compById.get(String(compId));
          if (!meta?.code) continue;
          if (codeSet.has(meta.code)) sum += Number(amount ?? 0) || 0;
        }
        return sum;
      };

      const getBreakdownSumByTypeExcludingCodes = (
        breakdown: Record<string, any>,
        type: 'EARNING' | 'DEDUCTION',
        excludeCodes: string[],
      ): number => {
        const exclude = new Set(excludeCodes.map((c) => c.toUpperCase()));
        let sum = 0;
        for (const [compId, amount] of Object.entries(breakdown || {})) {
          const meta = compById.get(String(compId));
          if (!meta?.code) continue;
          if (meta.type !== type) continue;
          if (exclude.has(meta.code)) continue;
          sum += Number(amount ?? 0) || 0;
        }
        return sum;
      };

      const computePayDays = (
        userId: string,
        departmentId: string | null,
        workingDays: unknown,
        from: string,
        to: string,
      ): number => {
        const wd = Array.isArray(workingDays) ? (workingDays as string[]) : null;
        const userHolidaySet = holidaySetByUserId.get(String(userId)) ?? holidaySet;
        let count = 0;
        const cursor = new Date(`${from}T00:00:00.000Z`);
        const end = new Date(`${to}T00:00:00.000Z`);
        while (cursor <= end) {
          const dayStr = formatDateLocal(cursor);
          if (
            isUserAttendanceScheduledDay({
              dateStr: dayStr,
              holidaySet: userHolidaySet,
              departmentId,
              workingDays: wd,
            })
          ) {
            count += 1;
          }
          cursor.setUTCDate(cursor.getUTCDate() + 1);
        }
        return count;
      };

      const dataRows = rows.map((r: any, idx: number) => {
        const userId = String(r.user_id);
        const breakdown: Record<string, any> = (r.component_breakdown ?? {}) as any;

        const basic = getBreakdownAmountByCodes(breakdown, ['BASIC', 'BASIC_SALARY']);
        const hra = getBreakdownAmountByCodes(breakdown, ['HRA']);
        const specialAl = getBreakdownAmountByCodes(breakdown, ['SPECIAL_AL', 'SPECIAL_ALLOWANCE']);
        const standardA = getBreakdownAmountByCodes(breakdown, [
          'STANDARD_A',
          'STANDARD_ALLOWANCE',
        ]);
        const arrears = getBreakdownAmountByCodes(breakdown, ['ARREARS']);
        const bonus = Number(r.bonus_amount ?? 0) || 0;
        const incentive = Number(r.incentive_amount ?? 0) || 0;
        const allowance = Number(r.allowance_amount ?? 0) || 0;

        const knownEarningCodes = [
          'BASIC',
          'BASIC_SALARY',
          'HRA',
          'SPECIAL_AL',
          'SPECIAL_ALLOWANCE',
          'STANDARD_A',
          'STANDARD_ALLOWANCE',
          'ARREARS',
        ];
        const otherEarningsFromBreakdown = getBreakdownSumByTypeExcludingCodes(
          breakdown,
          'EARNING',
          knownEarningCodes,
        );
        const othersEarnings = otherEarningsFromBreakdown + bonus + incentive + allowance;

        const totalEarnings = Number(r.total_earnings ?? 0) || 0;

        const esi = 0;
        const pf = Number(r.pf_contribution ?? 0) || 0;
        const pt = Number(r.professional_tax ?? 0) || 0;
        const tds = getBreakdownAmountByCodes(breakdown, ['TDS', 'INCOME_TAX', 'INCOME_TAX_TDS']);
        const salaryAdvance = getBreakdownAmountByCodes(breakdown, ['SALARY_ADVANCE']);
        const knownDeductionCodes = ['TDS', 'INCOME_TAX', 'INCOME_TAX_TDS', 'SALARY_ADVANCE'];
        const othersDeduction = getBreakdownSumByTypeExcludingCodes(
          breakdown,
          'DEDUCTION',
          knownDeductionCodes,
        );
        const totalDeductions = Number(r.total_deductions ?? 0) || 0;

        const netSalary = Number(r.net_salary ?? 0) || 0;
        const netAmount = netSalary + incentive - totalDeductions;

        const employerTotalAnnual = Number(r.employer_total_contributions ?? 0) || 0;
        const employerMonthly = employerTotalAnnual / 12;
        const grossSalary = Number(r.gross_salary ?? 0) || 0;
        const ctc = grossSalary + employerMonthly;

        const payDays =
          reportFrom && reportTo
            ? computePayDays(
                userId,
                r.department_id ? String(r.department_id) : null,
                r.department_working_days,
                reportFrom,
                reportTo,
              )
            : 0;
        const presentDays = presentDaysByUserId.get(userId) ?? 0;

        return [
          idx + 1,
          r.employee_id ?? '',
          `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(),
          r.pf_number ?? '',
          r.esi_number ?? '',
          r.pan_number ?? '',
          r.bank_name ?? '',
          r.account_number ?? '',
          r.ifsc_code ?? '',
          r.designation ?? '',
          r.department_name ?? '',
          r.aadhaar_number ?? '',
          payDays,
          presentDays,
          Number(ctc.toFixed(2)),
          Number(basic.toFixed(2)),
          Number(hra.toFixed(2)),
          Number(specialAl.toFixed(2)),
          Number(standardA.toFixed(2)),
          Number(othersEarnings.toFixed(2)),
          Number(bonus.toFixed(2)),
          Number(arrears.toFixed(2)),
          Number(totalEarnings.toFixed(2)),
          Number(esi.toFixed(2)),
          Number(pf.toFixed(2)),
          Number(pt.toFixed(2)),
          Number(tds.toFixed(2)),
          Number(salaryAdvance.toFixed(2)),
          Number(othersDeduction.toFixed(2)),
          Number(totalDeductions.toFixed(2)),
          Number(netAmount.toFixed(2)),
        ];
      });

      const worksheetData = [...headerRows, ...dataRows];
      const worksheet = XLSX.utils.aoa_to_sheet(worksheetData);

      worksheet['!cols'] = [
        { wch: 8 }, // Sl. No
        { wch: 12 }, // Emp.ID
        { wch: 28 }, // Employee Name
        { wch: 18 }, // PF No.
        { wch: 18 }, // ESI No.
        { wch: 12 }, // PAN No.
        { wch: 22 }, // Bank Name
        { wch: 20 }, // Bank A/c No.
        { wch: 14 }, // IFSC
        { wch: 22 }, // Job Title
        { wch: 22 }, // Department
        { wch: 18 }, // Aadhaar No.
        { wch: 10 }, // Pay Days
        { wch: 12 }, // Present Days
        { wch: 12 }, // CTC
        { wch: 12 }, // BASIC
        { wch: 12 }, // HRA
        { wch: 12 }, // SPECIAL AL
        { wch: 12 }, // Standard A
        { wch: 12 }, // Others (E)
        { wch: 12 }, // BONUS
        { wch: 12 }, // Arrears
        { wch: 14 }, // Total Earnings
        { wch: 10 }, // ESI
        { wch: 10 }, // PF
        { wch: 10 }, // PT
        { wch: 10 }, // TDS
        { wch: 14 }, // Salary Advance
        { wch: 12 }, // Others (D)
        { wch: 14 }, // Total Deductions
        { wch: 14 }, // Net Amount
      ];

      XLSX.utils.book_append_sheet(workbook, worksheet, 'Payroll Report');

      const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
      const safeFrom = reportFrom || 'from';
      const safeTo = reportTo || 'to';
      const fileName = `payroll_report_${safeFrom}_to_${safeTo}.xlsx`;

      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename=\"${fileName}\"`,
        'Content-Length': excelBuffer.length.toString(),
      });

      res.end(excelBuffer);
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to download payroll excel',
      });
    }
  }

  private static async buildPayslipComponentsIncludingAdjustments(
    orgId: string,
    record: PayrollRecord,
  ): Promise<Array<{ component: SalaryComponent; amount: number }>> {
    const org_id = orgId;

    const ensureComponent = async (input: {
      code: string;
      name: string;
      type: SalaryComponent['type'];
      display_order: number;
      is_taxable?: boolean;
      is_pf_applicable?: boolean;
      is_esi_applicable?: boolean;
    }): Promise<SalaryComponent> => {
      const existing = await SalaryComponent.query()
        .where({ org_id, code: input.code })
        .whereNull('deleted_at')
        .first();
      if (existing) return existing;

      try {
        return await SalaryComponent.query().insert({
          org_id,
          code: input.code,
          name: input.name,
          type: input.type,
          display_order: input.display_order,
          is_taxable: input.is_taxable ?? true,
          is_pf_applicable: input.is_pf_applicable ?? false,
          is_esi_applicable: input.is_esi_applicable ?? false,
          is_active: true,
        } as any);
      } catch (err) {
        const reloaded = await SalaryComponent.query()
          .where({ org_id, code: input.code })
          .whereNull('deleted_at')
          .first();
        if (reloaded) return reloaded;
        throw err;
      }
    };

    // Base components from component_breakdown (filter out empty strings to avoid SQL errors)
    const componentIds = Object.keys((record as any).component_breakdown || {}).filter(
      (id) => id && id.trim() !== '',
    );
    const baseComponents =
      componentIds.length > 0 ? await SalaryComponent.query().whereIn('id', componentIds) : [];
    const baseComponentData = baseComponents.map((comp) => ({
      component: comp,
      amount: Number((record as any).component_breakdown?.[comp.id] || 0) || 0,
    }));
    const baseCodes = new Set(
      baseComponentData
        .map((c) =>
          String((c as any)?.component?.code || '')
            .trim()
            .toUpperCase(),
        )
        .filter(Boolean),
    );

    // Adjustment fields stored on payroll record (not in component_breakdown)
    const overtimeAmount = Number((record as any).overtime_amount ?? 0) || 0;
    const incentiveAmount = Number((record as any).incentive_amount ?? 0) || 0;
    const bonusAmount = Number((record as any).bonus_amount ?? 0) || 0;
    const pfContribution = Number((record as any).pf_contribution ?? 0) || 0;
    const professionalTax = Number((record as any).professional_tax ?? 0) || 0;

    const shouldAddAny =
      overtimeAmount > 0 ||
      incentiveAmount > 0 ||
      bonusAmount > 0 ||
      pfContribution > 0 ||
      professionalTax > 0;

    const adjustedComponentData: Array<{ component: SalaryComponent; amount: number }> = [];
    if (shouldAddAny) {
      const [overtimeComp, incentiveComp, bonusComp, pfComp, profTaxComp] = await Promise.all([
        ensureComponent({
          code: 'OVERTIME',
          name: 'Overtime',
          type: 'OVERTIME',
          display_order: 210,
        }),
        ensureComponent({
          code: 'INCENTIVE',
          name: 'Incentive',
          type: 'INCENTIVE',
          display_order: 220,
        }),
        ensureComponent({ code: 'BONUS', name: 'Bonus', type: 'BONUS', display_order: 230 }),
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

      if (overtimeAmount > 0 && !baseCodes.has('OVERTIME'))
        adjustedComponentData.push({ component: overtimeComp, amount: overtimeAmount });
      if (incentiveAmount > 0 && !baseCodes.has('INCENTIVE'))
        adjustedComponentData.push({ component: incentiveComp, amount: incentiveAmount });
      if (bonusAmount > 0 && !baseCodes.has('BONUS'))
        adjustedComponentData.push({ component: bonusComp, amount: bonusAmount });
      if (pfContribution > 0 && !baseCodes.has('PF'))
        adjustedComponentData.push({ component: pfComp, amount: pfContribution });
      if (professionalTax > 0 && !baseCodes.has('PROFESSIONAL_TAX'))
        adjustedComponentData.push({ component: profTaxComp, amount: professionalTax });
    }

    const components = [...baseComponentData, ...adjustedComponentData];

    // If base salary structure contains statutory deductions (e.g., PF) but the payroll record has
    // an overridden value (e.g., after adjustment), prefer the payroll record column amount so PDF
    // reflects the actual paid payroll.
    const pfContributionFromRecord = Number((record as any).pf_contribution ?? 0) || 0;
    if (pfContributionFromRecord > 0) {
      for (const row of components) {
        const code = String((row as any)?.component?.code || '')
          .trim()
          .toUpperCase();
        if (code === 'PF') {
          row.amount = pfContributionFromRecord;
        }
      }
    }

    return components;
  }

  static async regeneratePayslipPdfUrlForRecord(
    orgId: string,
    payrollRecordId: string,
  ): Promise<string> {
    const record = await PayrollRecord.query()
      .withGraphJoined('user')
      .findOne({ 'payroll_records.id': payrollRecordId, 'payroll_records.org_id': orgId });

    if (!record) {
      throw new Error('Payroll record not found');
    }

    const org_id = orgId;

    const ensureComponent = async (input: {
      code: string;
      name: string;
      type: SalaryComponent['type'];
      display_order: number;
      is_taxable?: boolean;
      is_pf_applicable?: boolean;
      is_esi_applicable?: boolean;
    }): Promise<SalaryComponent> => {
      const existing = await SalaryComponent.query()
        .where({ org_id, code: input.code })
        .whereNull('deleted_at')
        .first();
      if (existing) return existing;

      try {
        return await SalaryComponent.query().insert({
          org_id,
          code: input.code,
          name: input.name,
          type: input.type,
          display_order: input.display_order,
          is_taxable: input.is_taxable ?? true,
          is_pf_applicable: input.is_pf_applicable ?? false,
          is_esi_applicable: input.is_esi_applicable ?? false,
          is_active: true,
        } as any);
      } catch (err) {
        // If parallel requests raced on unique(org_id, code), reload.
        const reloaded = await SalaryComponent.query()
          .where({ org_id, code: input.code })
          .whereNull('deleted_at')
          .first();
        if (reloaded) return reloaded;
        throw err;
      }
    };

    // Get salary components from component_breakdown (filter out empty strings to avoid SQL errors)
    const componentIds = Object.keys(record.component_breakdown || {}).filter(
      (id) => id && id.trim() !== '',
    );
    const baseComponents =
      componentIds.length > 0 ? await SalaryComponent.query().whereIn('id', componentIds) : [];

    const baseComponentData = baseComponents.map((comp) => ({
      component: comp,
      amount: record.component_breakdown[comp.id] || 0,
    }));

    // Ensure standard adjustment components exist and include them if record has amounts.
    const [overtimeComp, incentiveComp, bonusComp, pfComp, profTaxComp] = await Promise.all([
      ensureComponent({
        code: 'OVERTIME',
        name: 'Overtime',
        type: 'OVERTIME',
        display_order: 210,
      }),
      ensureComponent({
        code: 'INCENTIVE',
        name: 'Incentive',
        type: 'INCENTIVE',
        display_order: 220,
      }),
      ensureComponent({
        code: 'BONUS',
        name: 'Bonus',
        type: 'BONUS',
        display_order: 230,
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

    const adjustedComponentData: Array<{ component: SalaryComponent; amount: number }> = [];
    const overtimeAmount = Number((record as any).overtime_amount ?? 0) || 0;
    const incentiveAmount = Number((record as any).incentive_amount ?? 0) || 0;
    const bonusAmount = Number((record as any).bonus_amount ?? 0) || 0;
    const pfContribution = Number((record as any).pf_contribution ?? 0) || 0;
    const professionalTax = Number((record as any).professional_tax ?? 0) || 0;

    if (overtimeAmount > 0)
      adjustedComponentData.push({ component: overtimeComp, amount: overtimeAmount });
    if (incentiveAmount > 0)
      adjustedComponentData.push({ component: incentiveComp, amount: incentiveAmount });
    if (bonusAmount > 0) adjustedComponentData.push({ component: bonusComp, amount: bonusAmount });
    if (pfContribution > 0)
      adjustedComponentData.push({ component: pfComp, amount: pfContribution });
    if (professionalTax > 0)
      adjustedComponentData.push({ component: profTaxComp, amount: professionalTax });

    const componentData = [...baseComponentData, ...adjustedComponentData];

    // Org + user details (best-effort)
    let orgName: string | undefined;
    let orgEmail: string | undefined;
    let orgAddress: string | undefined;
    let orgLogoUrl: string | undefined;
    let departmentName: string | undefined;
    let locationName: string | undefined;
    let panNumber: string | undefined;
    let uanNumber: string | undefined;
    let pfNumber: string | undefined;
    let bankAccount: string | undefined;
    let standardDays: number | undefined;
    let workingDays: number | undefined;
    let lopDays: number | undefined;

    const { Organization } = await import('../../models/Organization');
    const { OfficeLocation } = await import('../../models/OfficeLocation');
    const org = await Organization.query().findById(orgId);
    orgName = org?.name;
    orgEmail = org?.contact_email;
    orgAddress = org?.address;
    orgLogoUrl = org?.logo_url;
    if (!orgAddress) {
      const officeLocation = await OfficeLocation.query().where('org_id', orgId).first();
      orgAddress = officeLocation?.address;
    }

    const user = (record as any).user as User;
    if (!user) {
      throw new Error('User not found for payroll record');
    }
    const freshUser = await User.query().findById(user.id).withGraphJoined('[department.location]');
    const payslipUser = (freshUser || user) as User;

    const { Department } = await import('../../models/Department');
    const { UserPayrollDetail } = await import('../../models/UserPayrollDetail');
    const { BankDetail } = await import('../../models/BankDetail');

    const payrollDetail = await UserPayrollDetail.query().findOne({ user_id: payslipUser.id });
    const bankDetail = await BankDetail.query().findOne({ user_id: payslipUser.id });
    const department = payslipUser.department_id
      ? await Department.query().findById(payslipUser.department_id)
      : null;

    departmentName = (freshUser as any)?.department?.name || department?.name;
    locationName =
      (freshUser as any)?.department?.location?.name ||
      (freshUser as any)?.department?.location?.address;
    if (!locationName && department?.location_id) {
      const deptLocation = await OfficeLocation.query().findById(department.location_id);
      locationName = deptLocation?.name || deptLocation?.address;
    }

    panNumber = payrollDetail?.pan_number;
    uanNumber = payrollDetail?.uan_number;
    pfNumber = payrollDetail?.pf_number;
    bankAccount =
      bankDetail?.bank_name && bankDetail?.account_number
        ? `${bankDetail.bank_name} - ${bankDetail.account_number}`
        : bankDetail?.account_number;

    const payslipMetrics = await computePayslipAttendanceMetrics({
      orgId: record.org_id,
      userId: payslipUser.id,
      payrollMonth: Number(record.payroll_month || 1),
      payrollYear: Number(record.payroll_year || new Date().getFullYear()),
    });
    standardDays = payslipMetrics.standardDays;
    workingDays = payslipMetrics.workingDays;
    lopDays = payslipMetrics.lopDays;

    const pdfUrl = await PayslipPdfService.generateAndUploadPayslip({
      payrollRecord: record,
      user: payslipUser,
      components: componentData,
      organizationName: orgName,
      organizationLogoUrl: orgLogoUrl,
      organizationEmail: orgEmail,
      organizationAddress: orgAddress,
      departmentName,
      locationName,
      panNumber,
      uanNumber,
      pfNumber,
      bankAccount,
      standardDays,
      workingDays,
      lopDays,
    });

    await record.$query().patch({ payslip_pdf_url: pdfUrl });

    return pdfUrl;
  }

  /**
   * Get all salary components for organization
   */
  static async getSalaryComponents(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    try {
      const components = await SalaryComponent.query()
        .where({ org_id: req.user.org_id })
        .whereNull('deleted_at')
        .orderBy('display_order', 'asc')
        .orderBy('name', 'asc');

      return res.json(components);
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to fetch salary components',
      });
    }
  }

  /**
   * Create salary component
   */
  static async createSalaryComponent(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = createSalaryComponentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    try {
      // Check if code already exists
      const existing = await SalaryComponent.query().findOne({
        org_id: req.user.org_id,
        code: parsed.data.code,
        deleted_at: null,
      });

      if (existing) {
        return res.status(409).json({ message: 'Salary component code already exists' });
      }

      const component = await SalaryComponent.query().insert({
        org_id: req.user.org_id,
        ...parsed.data,
      });

      return res.status(201).json(component);
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to create salary component',
      });
    }
  }

  /**
   * Update salary component
   */
  static async updateSalaryComponent(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    const parsed = updateSalaryComponentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    try {
      const component = await SalaryComponent.query().findOne({
        id,
        org_id: req.user.org_id,
        deleted_at: null,
      });

      if (!component) {
        return res.status(404).json({ message: 'Salary component not found' });
      }

      // Check code uniqueness if code is being updated
      if (parsed.data.code && parsed.data.code !== component.code) {
        const existing = await SalaryComponent.query().findOne({
          org_id: req.user.org_id,
          code: parsed.data.code,
          deleted_at: null,
        });

        if (existing) {
          return res.status(409).json({ message: 'Salary component code already exists' });
        }
      }

      await component.$query().patch(parsed.data);
      const updated = await SalaryComponent.query().findById(id);

      return res.json(updated!);
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to update salary component',
      });
    }
  }

  /**
   * Delete salary component (soft delete)
   */
  static async deleteSalaryComponent(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;

    try {
      const component = await SalaryComponent.query().findOne({
        id,
        org_id: req.user.org_id,
        deleted_at: null,
      });

      if (!component) {
        return res.status(404).json({ message: 'Salary component not found' });
      }

      await component.$query().patch({ deleted_at: new Date(), is_active: false });

      return res.json({ message: 'Salary component deleted successfully' });
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to delete salary component',
      });
    }
  }

  /**
   * Create salary structure for user
   */
  static async createSalaryStructure(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = createSalaryStructureSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    try {
      // Verify user belongs to same org
      const user = await User.query().findOne({
        id: parsed.data.user_id,
        org_id: req.user.org_id,
      });

      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      // Verify all components belong to org
      const componentIds = Object.keys(parsed.data.component_breakdown);
      const components = await SalaryComponent.query()
        .whereIn('id', componentIds)
        .where({ org_id: req.user.org_id, deleted_at: null });

      if (components.length !== componentIds.length) {
        return res.status(400).json({ message: 'Invalid salary components' });
      }

      // Deactivate existing active structures
      await SalaryStructure.query()
        .where({ user_id: parsed.data.user_id, is_active: true, deleted_at: null })
        .patch({ is_active: false });

      const insertData: any = {
        org_id: req.user.org_id,
        user_id: parsed.data.user_id,
        effective_from: new Date(parsed.data.effective_from),
        gross_salary: parsed.data.gross_salary,
        net_salary: parsed.data.net_salary,
        component_breakdown: parsed.data.component_breakdown,
      };
      if (parsed.data.effective_to) {
        insertData.effective_to = new Date(parsed.data.effective_to);
      }
      if (parsed.data.notes !== undefined) {
        insertData.notes = parsed.data.notes;
      }
      const structure = await SalaryStructure.query().insert(insertData);

      generateCurrentMonthPayrollForUser(user.id, req.user.org_id).catch((err) => {
        logger.error(
          { err, user_id: user.id, org_id: req.user.org_id },
          'Failed to auto-generate current month payroll after salary structure create',
        );
      });

      return res.status(201).json(structure);
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to create salary structure',
      });
    }
  }

  /**
   * Update salary structure
   */
  static async updateSalaryStructure(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    const parsed = updateSalaryStructureSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    try {
      const structure = await SalaryStructure.query().findOne({
        id,
        org_id: req.user.org_id,
        deleted_at: null,
      });

      if (!structure) {
        return res.status(404).json({ message: 'Salary structure not found' });
      }

      // Verify user if user_id is being updated
      if (parsed.data.user_id) {
        const user = await User.query().findOne({
          id: parsed.data.user_id,
          org_id: req.user.org_id,
        });

        if (!user) {
          return res.status(404).json({ message: 'User not found' });
        }
      }

      // Verify components if component_breakdown is being updated
      if (parsed.data.component_breakdown) {
        const componentIds = Object.keys(parsed.data.component_breakdown);
        const components = await SalaryComponent.query()
          .whereIn('id', componentIds)
          .where({ org_id: req.user.org_id, deleted_at: null });

        if (components.length !== componentIds.length) {
          return res.status(400).json({ message: 'Invalid salary components' });
        }
      }

      const updateData: any = { ...parsed.data };
      if (updateData.effective_from) {
        updateData.effective_from = new Date(updateData.effective_from);
      }
      if (updateData.effective_to !== undefined) {
        updateData.effective_to = updateData.effective_to
          ? new Date(updateData.effective_to)
          : null;
      }

      await structure.$query().patch(updateData);
      const updated = await SalaryStructure.query().findById(id);

      const userIdForPayroll = String((updated as any)?.user_id ?? (structure as any).user_id);
      if (userIdForPayroll) {
        generateCurrentMonthPayrollForUser(userIdForPayroll, req.user.org_id).catch((err) => {
          logger.error(
            { err, user_id: userIdForPayroll, org_id: req.user.org_id },
            'Failed to auto-generate current month payroll after salary structure update',
          );
        });
      }

      return res.json(updated!);
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to update salary structure',
      });
    }
  }

  /**
   * Get salary structures for user or all
   */
  static async getSalaryStructures(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { userId } = req.query;

    try {
      let query = SalaryStructure.query()
        .where({ org_id: req.user.org_id, deleted_at: null })
        .withGraphJoined('user')
        .orderBy('effective_from', 'desc');

      if (userId) {
        query = query.where('user_id', userId as string);
      }

      const structures = await query;

      return res.json(structures);
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to fetch salary structures',
      });
    }
  }

  static async getOrgPayrollSettings(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const org_id = req.user.org_id;

    try {
      const setting = await OrgPayrollSetting.query().findOne({ org_id });
      if (!setting) {
        return res.json({ exists: false, data: null });
      }

      return res.json({ exists: true, data: normalizeOrgPayrollSetting(setting) });
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to fetch payroll settings',
      });
    }
  }

  static async upsertOrgPayrollSettings(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = upsertOrgPayrollSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const org_id = req.user.org_id;
    const payload = parsed.data;

    try {
      const existing = await OrgPayrollSetting.query().findOne({ org_id });

      const pfEmployerType = payload.employer_pf.type as 'PERCENTAGE' | 'FIXED';
      const pfEmployeeType = payload.employee_pf.type as 'PERCENTAGE' | 'FIXED';

      let saved: OrgPayrollSetting;
      if (existing) {
        saved = await OrgPayrollSetting.query().patchAndFetchById(existing.id, {
          basic_pct: payload.basic_pct,
          hra_pct_of_basic: payload.hra_pct_of_basic,
          employer_pf_type: pfEmployerType,
          employer_pf_value: payload.employer_pf.value,
          employee_pf_type: pfEmployeeType,
          employee_pf_value: payload.employee_pf.value,
          professional_tax_annual: payload.professional_tax_annual,
        });
      } else {
        saved = await OrgPayrollSetting.query().insert({
          org_id,
          basic_pct: payload.basic_pct,
          hra_pct_of_basic: payload.hra_pct_of_basic,
          employer_pf_type: pfEmployerType,
          employer_pf_value: payload.employer_pf.value,
          employee_pf_type: pfEmployeeType,
          employee_pf_value: payload.employee_pf.value,
          professional_tax_annual: payload.professional_tax_annual,
        });
      }

      return res.json({ exists: true, data: normalizeOrgPayrollSetting(saved) });
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to update payroll settings',
      });
    }
  }

  static async previewOrgPayrollSettings(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = payrollSettingsPreviewQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const org_id = req.user.org_id;

    try {
      const setting = await OrgPayrollSetting.query().findOne({ org_id });
      if (!setting) {
        return res.status(404).json({
          message: 'Payroll settings not configured for organization',
        });
      }

      const normalized = normalizeOrgPayrollSetting(setting);
      const breakdown = computePayrollSettingsBreakdown({
        annual_ctc: parsed.data.annual_ctc,
        settings: normalized,
      });

      return res.json({
        annual_ctc_input: parsed.data.annual_ctc,
        settings: normalized,
        breakdown,
      });
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to compute preview',
      });
    }
  }

  static async previewOrgPayrollSettingsForUser(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const org_id = req.user.org_id;
    const { userId } = req.params as { userId?: string };
    if (!userId) {
      return res.status(400).json({ message: 'userId is required' });
    }

    try {
      const user = await User.query().findOne({ id: userId, org_id });
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      const employment = await EmployeeEmploymentDetail.query().findOne({ user_id: userId });
      const annualCtcRaw = employment?.annual_ctc;
      const annual_ctc = annualCtcRaw == null ? null : Number(annualCtcRaw);
      if (!annual_ctc || !Number.isFinite(annual_ctc) || annual_ctc <= 0) {
        return res.status(400).json({ message: 'User annual_ctc is not set' });
      }

      const setting = await OrgPayrollSetting.query().findOne({ org_id });
      if (!setting) {
        return res.status(404).json({
          message: 'Payroll settings not configured for organization',
        });
      }

      const normalized = normalizeOrgPayrollSetting(setting);
      const breakdown = computePayrollSettingsBreakdown({ annual_ctc, settings: normalized });

      return res.json({
        user_id: userId,
        annual_ctc_input: annual_ctc,
        settings: normalized,
        breakdown,
      });
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to compute preview',
      });
    }
  }

  /**
   * Upload payroll file (Excel/PDF)
   */
  static uploadPayrollFile = [
    upload.single('file'),
    async (req: Request, res: Response): Promise<Response> => {
      if (!req.user) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      const parsed = payrollUploadQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          message: 'Invalid query parameters',
          errors: parsed.error.flatten().fieldErrors,
        });
      }

      if (!req.file) {
        return res.status(400).json({ message: 'No file uploaded' });
      }

      const { month, year } = parsed.data;
      const fileType = req.file.mimetype.includes('pdf') ? 'PDF' : 'EXCEL';

      try {
        // Upload file to S3
        const key = [
          'orgs',
          req.user.org_id,
          'payroll-uploads',
          `${year}-${String(month).padStart(2, '0')}`,
          `${crypto.randomUUID()}-${req.file.originalname}`,
        ].join('/');

        const command = new PutObjectCommand({
          Bucket: env.S3_BUCKET!,
          Key: key,
          ContentType: req.file.mimetype,
          Body: req.file.buffer,
        });

        await getS3Client().send(command);
        const fileUrl = buildS3PublicUrl(key);

        // Create upload record
        const uploadRecord = await PayrollUpload.query().insert({
          org_id: req.user.org_id,
          uploaded_by: req.user.id,
          payroll_month: month,
          payroll_year: year,
          file_type: fileType,
          file_url: fileUrl,
          file_name: req.file.originalname,
          status: 'UPLOADED',
        });

        // Process file asynchronously (in production, use a queue)
        if (fileType === 'EXCEL') {
          // Process Excel file
          processExcelPayrollFile(
            uploadRecord.id,
            req.file.buffer,
            req.user.org_id,
            month,
            year,
          ).catch((error) => {
            logger.error({ err: error }, 'Error processing Excel file');
          });
        }

        return res.status(201).json({
          id: uploadRecord.id,
          file_url: fileUrl,
          status: uploadRecord.status,
          message: 'File uploaded successfully. Processing in background.',
        });
      } catch (error) {
        return res.status(500).json({
          message: error instanceof Error ? error.message : 'Failed to upload file',
        });
      }
    },
  ];

  /**
   * Get payroll records list
   */
  static async getPayrollRecords(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = payrollRecordsListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { page, limit, month, year, from_date, to_date, user_id, status, search } = parsed.data;

    try {
      // Build base query for counting (without graph join)
      let countQuery = PayrollRecord.query()
        .where('payroll_records.org_id', req.user.org_id)
        .join('users', 'payroll_records.user_id', 'users.id');

      // Build query for fetching records (with graph join)
      // Note: withGraphJoined('user') creates a LEFT JOIN with alias "user"
      let dataQuery = PayrollRecord.query()
        .where('payroll_records.org_id', req.user.org_id)
        .withGraphJoined('user')
        .orderBy('payroll_records.payroll_year', 'desc')
        .orderBy('payroll_records.payroll_month', 'desc')
        .orderBy('payroll_records.created_at', 'desc');

      // Apply filters to both queries
      if (month) {
        countQuery = countQuery.where('payroll_records.payroll_month', month);
        dataQuery = dataQuery.where('payroll_records.payroll_month', month);
      }
      if (year) {
        countQuery = countQuery.where('payroll_records.payroll_year', year);
        dataQuery = dataQuery.where('payroll_records.payroll_year', year);
      }
      if (from_date && to_date) {
        // Filter by payroll period date (make_date(payroll_year, payroll_month, 1))
        // This filters records where the payroll period falls within the date range
        countQuery = countQuery.whereRaw(
          'make_date(payroll_records.payroll_year, payroll_records.payroll_month, 1) between ?::date and ?::date',
          [from_date, to_date],
        );
        dataQuery = dataQuery.whereRaw(
          'make_date(payroll_records.payroll_year, payroll_records.payroll_month, 1) between ?::date and ?::date',
          [from_date, to_date],
        );
      }
      if (user_id) {
        countQuery = countQuery.where('payroll_records.user_id', user_id);
        dataQuery = dataQuery.where('payroll_records.user_id', user_id);
      }
      if (status) {
        countQuery = countQuery.where('payroll_records.status', status);
        dataQuery = dataQuery.where('payroll_records.status', status);
      }
      if (search) {
        const searchTerm = `%${search.toLowerCase()}%`;
        // Count query uses "users" table (from join)
        countQuery = countQuery.where((builder) => {
          builder
            .whereRaw('LOWER(users.first_name) LIKE ?', [searchTerm])
            .orWhereRaw('LOWER(users.last_name) LIKE ?', [searchTerm])
            .orWhereRaw('LOWER(users.employee_id) LIKE ?', [searchTerm]);
        });
        // Data query uses "user" alias (from withGraphJoined)
        dataQuery = dataQuery.where((builder) => {
          builder
            .whereRaw('LOWER("user".first_name) LIKE ?', [searchTerm])
            .orWhereRaw('LOWER("user".last_name) LIKE ?', [searchTerm])
            .orWhereRaw('LOWER("user".employee_id) LIKE ?', [searchTerm]);
        });
      }

      // Get total count (count distinct to avoid duplicates from join)
      const total = await countQuery.countDistinct('payroll_records.id as count').first();
      const totalCount = Number((total as { count?: string | number } | undefined)?.count ?? 0);

      // Get paginated records
      const records = await dataQuery.page(page - 1, limit);

      return res.json({
        items: records.results,
        pagination: {
          page,
          limit,
          total: totalCount,
          total_pages: Math.ceil(totalCount / limit),
        },
      });
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to fetch payroll records',
      });
    }
  }

  /**
   * Create payroll record manually
   */
  static async createPayrollRecord(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = createPayrollRecordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    try {
      // Verify user belongs to same org
      const user = await User.query().findOne({
        id: parsed.data.user_id,
        org_id: req.user.org_id,
      });

      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      // Check if record already exists
      const existing = await PayrollRecord.query().findOne({
        user_id: parsed.data.user_id,
        payroll_month: parsed.data.payroll_month,
        payroll_year: parsed.data.payroll_year,
      });

      if (existing) {
        return res.status(409).json({ message: 'Payroll record already exists for this month' });
      }

      const insertData: any = {
        org_id: req.user.org_id,
        user_id: parsed.data.user_id,
        payroll_month: parsed.data.payroll_month,
        payroll_year: parsed.data.payroll_year,
        gross_salary: parsed.data.gross_salary,
        total_earnings: parsed.data.total_earnings,
        total_deductions: parsed.data.total_deductions,
        net_salary: parsed.data.net_salary,
        component_breakdown: parsed.data.component_breakdown ?? {},
        status: 'PENDING',
      };
      if (parsed.data.pf_contribution !== undefined && parsed.data.pf_contribution !== null) {
        insertData.pf_contribution = parsed.data.pf_contribution;
      }
      if (parsed.data.professional_tax !== undefined && parsed.data.professional_tax !== null) {
        insertData.professional_tax = parsed.data.professional_tax;
      }
      if (parsed.data.overtime_amount !== undefined) {
        insertData.overtime_amount = parsed.data.overtime_amount;
      }
      if (parsed.data.incentive_amount !== undefined) {
        insertData.incentive_amount = parsed.data.incentive_amount;
      }
      if (parsed.data.bonus_amount !== undefined) {
        insertData.bonus_amount = parsed.data.bonus_amount;
      }
      if (parsed.data.allowance_amount !== undefined) {
        insertData.allowance_amount = parsed.data.allowance_amount;
      }
      if (parsed.data.notes !== undefined && parsed.data.notes !== null) {
        insertData.notes = parsed.data.notes;
      }
      const record = await PayrollRecord.query().insert(insertData);

      return res.status(201).json(record);
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to create payroll record',
      });
    }
  }

  /**
   * Update payroll record
   */
  static async updatePayrollRecord(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    const parsed = updatePayrollRecordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    try {
      const record = await PayrollRecord.query().withGraphJoined('user').findOne({
        'payroll_records.id': id,
        'payroll_records.org_id': req.user.org_id,
      });

      if (!record) {
        return res.status(404).json({ message: 'Payroll record not found' });
      }

      const patchData: any = {};
      if (parsed.data.gross_salary !== undefined) patchData.gross_salary = parsed.data.gross_salary;
      if (parsed.data.total_earnings !== undefined)
        patchData.total_earnings = parsed.data.total_earnings;
      if (parsed.data.total_deductions !== undefined)
        patchData.total_deductions = parsed.data.total_deductions;
      if (parsed.data.net_salary !== undefined) patchData.net_salary = parsed.data.net_salary;
      if (parsed.data.pf_contribution !== undefined)
        patchData.pf_contribution = parsed.data.pf_contribution;
      if (parsed.data.professional_tax !== undefined)
        patchData.professional_tax = parsed.data.professional_tax;
      if (parsed.data.overtime_amount !== undefined)
        patchData.overtime_amount = parsed.data.overtime_amount;
      if (parsed.data.incentive_amount !== undefined)
        patchData.incentive_amount = parsed.data.incentive_amount;
      if (parsed.data.bonus_amount !== undefined) patchData.bonus_amount = parsed.data.bonus_amount;
      if (parsed.data.allowance_amount !== undefined)
        patchData.allowance_amount = parsed.data.allowance_amount;
      if (parsed.data.component_breakdown !== undefined)
        patchData.component_breakdown = parsed.data.component_breakdown;
      if (parsed.data.notes !== undefined) patchData.notes = parsed.data.notes;
      if (parsed.data.status !== undefined) {
        patchData.status = parsed.data.status;
        // Set paid_at timestamp when status is set to PAID
        if (parsed.data.status === 'PAID') {
          patchData.paid_at = new Date();

          // Generate and upload payslip PDF when marking as PAID.
          // Always regenerate so latest department/payroll profile updates are reflected.
          try {
            const recordForPdf = { ...(record as any), ...(patchData as any) } as PayrollRecord;

            // Get user from graph join
            const user = (record as any).user as User;
            if (!user) {
              return res.status(404).json({ message: 'User not found for payroll record' });
            }

            // Get salary components from component_breakdown
            // Filter out empty strings and invalid UUIDs to prevent SQL errors
            const components =
              await AdminPayrollController.buildPayslipComponentsIncludingAdjustments(
                req.user.org_id,
                recordForPdf as any,
              );

            // Get organization details
            let orgName: string | undefined;
            let orgEmail: string | undefined;
            let orgAddress: string | undefined;
            let orgPhone: string | undefined;
            let orgLogoUrl: string | undefined;
            let departmentName: string | undefined;
            let locationName: string | undefined;
            let panNumber: string | undefined;
            let uanNumber: string | undefined;
            let pfNumber: string | undefined;
            let bankAccount: string | undefined;
            let standardDays: number | undefined;
            let workingDays: number | undefined;
            let lopDays: number | undefined;
            if (req.user.org_id) {
              const { Organization } = await import('../../models/Organization');
              const { OfficeLocation } = await import('../../models/OfficeLocation');
              const org = await Organization.query().findById(req.user.org_id);
              if (org) {
                orgName = org.name;
                orgEmail = org.contact_email;
                orgLogoUrl = org.logo_url;
                // Get primary office location for address
                const officeLocation = await OfficeLocation.query()
                  .where('org_id', req.user.org_id)
                  .first();
                if (officeLocation?.address) {
                  orgAddress = officeLocation.address;
                }
              }
            }

            const { Department } = await import('../../models/Department');
            const { UserPayrollDetail } = await import('../../models/UserPayrollDetail');
            const { BankDetail } = await import('../../models/BankDetail');
            const freshUser = await User.query()
              .findById(user.id)
              .withGraphJoined('[department.location]');
            const payslipUser = (freshUser || user) as User;
            const department = payslipUser.department_id
              ? await Department.query().findById(payslipUser.department_id)
              : null;
            const payrollDetail = await UserPayrollDetail.query().findOne({
              user_id: payslipUser.id,
            });
            const bankDetail = await BankDetail.query().findOne({ user_id: payslipUser.id });

            departmentName = (freshUser as any)?.department?.name || department?.name;
            if (!departmentName) {
              const fallbackDepartment = await Department.query()
                .alias('d')
                .join('users as u', 'u.department_id', 'd.id')
                .where('u.id', payslipUser.id)
                .select('d.name')
                .first();
              departmentName = (fallbackDepartment as any)?.name;
            }
            locationName =
              (freshUser as any)?.department?.location?.name ||
              (freshUser as any)?.department?.location?.address;
            if (!locationName && department?.location_id) {
              const { OfficeLocation } = await import('../../models/OfficeLocation');
              const deptLocation = await OfficeLocation.query().findById(department.location_id);
              locationName = deptLocation?.name || deptLocation?.address;
            }
            if (!departmentName) {
              const orgDepartment = await Department.query()
                .withGraphJoined('location')
                .where('departments.org_id', record.org_id)
                .whereNull('departments.deleted_at')
                .orderBy('departments.created_at', 'asc')
                .first();
              departmentName = orgDepartment?.name;
              if (!locationName) {
                locationName =
                  (orgDepartment as any)?.location?.name ||
                  (orgDepartment as any)?.location?.address;
              }
            }
            panNumber = payrollDetail?.pan_number;
            uanNumber = payrollDetail?.uan_number;
            pfNumber = payrollDetail?.pf_number;
            bankAccount =
              bankDetail?.bank_name && bankDetail?.account_number
                ? `${bankDetail.bank_name} - ${bankDetail.account_number}`
                : bankDetail?.account_number;

            const payslipMetricsPaid = await computePayslipAttendanceMetrics({
              orgId: record.org_id,
              userId: payslipUser.id,
              payrollMonth: Number(record.payroll_month || 1),
              payrollYear: Number(record.payroll_year || new Date().getFullYear()),
            });
            standardDays = payslipMetricsPaid.standardDays;
            workingDays = payslipMetricsPaid.workingDays;
            lopDays = payslipMetricsPaid.lopDays;

            // Generate PDF buffer
            const pdfBuffer = await PayslipPdfService.generatePayslipBuffer({
              payrollRecord: recordForPdf,
              user: payslipUser,
              components: components,
              organizationName: orgName,
              organizationLogoUrl: orgLogoUrl,
              organizationEmail: orgEmail,
              organizationAddress: orgAddress,
              organizationPhone: orgPhone,
              departmentName,
              locationName,
              panNumber,
              uanNumber,
              pfNumber,
              bankAccount,
              standardDays,
              workingDays,
              lopDays,
            });

            // Upload to S3
            const key = [
              'orgs',
              record.org_id,
              'users',
              record.user_id,
              'payslips',
              `${record.payroll_year}-${String(record.payroll_month).padStart(2, '0')}`,
              `payslip-${crypto.randomUUID()}.pdf`,
            ].join('/');

            const command = new PutObjectCommand({
              Bucket: env.S3_BUCKET!,
              Key: key,
              ContentType: 'application/pdf',
              Body: pdfBuffer,
            });

            await getS3Client().send(command);
            const pdfUrl = buildS3PublicUrl(key);
            patchData.payslip_pdf_url = pdfUrl;
          } catch (pdfError) {
            // Log error but don't fail the status update
            logger.error(
              `Failed to generate payslip PDF for payroll record ${id}: ${pdfError instanceof Error ? pdfError.message : 'Unknown error'}`,
            );
            // Continue with status update even if PDF generation fails
          }
        } else if (parsed.data.status === 'ADJUSTED') {
          patchData.processed_at = new Date();
        }
      }

      await record.$query().patch(patchData);
      const updated = await PayrollRecord.query().findById(id);

      return res.json(updated!);
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to update payroll record',
      });
    }
  }

  /**
   * Process payroll record (generate payslip PDF)
   */
  static async processPayrollRecord(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;

    try {
      const record = await PayrollRecord.query()
        .withGraphJoined('user')
        .findOne({ 'payroll_records.id': id, 'payroll_records.org_id': req.user.org_id });

      if (!record) {
        return res.status(404).json({ message: 'Payroll record not found' });
      }

      // Get salary components
      // Filter out empty strings and invalid UUIDs to prevent SQL errors
      const componentData = await AdminPayrollController.buildPayslipComponentsIncludingAdjustments(
        req.user.org_id,
        record as any,
      );

      // Get organization name
      let orgName: string | undefined;
      let orgEmail: string | undefined;
      let orgAddress: string | undefined;
      let orgLogoUrl: string | undefined;
      let departmentName: string | undefined;
      let locationName: string | undefined;
      let panNumber: string | undefined;
      let uanNumber: string | undefined;
      let pfNumber: string | undefined;
      let bankAccount: string | undefined;
      let standardDays: number | undefined;
      let workingDays: number | undefined;
      let lopDays: number | undefined;
      if (req.user.org_id) {
        const { Organization } = await import('../../models/Organization');
        const { OfficeLocation } = await import('../../models/OfficeLocation');
        const org = await Organization.query().findById(req.user.org_id);
        orgName = org?.name;
        orgEmail = org?.contact_email;
        orgAddress = org?.address;
        orgLogoUrl = org?.logo_url;
        if (!orgAddress) {
          const officeLocation = await OfficeLocation.query()
            .where('org_id', req.user.org_id)
            .first();
          orgAddress = officeLocation?.address;
        }
      }

      // Get user from graph join
      const user = (record as any).user as User;
      if (!user) {
        return res.status(404).json({ message: 'User not found for payroll record' });
      }
      const freshUser = await User.query()
        .findById(user.id)
        .withGraphJoined('[department.location]');
      const payslipUser = (freshUser || user) as User;

      const { Department } = await import('../../models/Department');
      const { OfficeLocation } = await import('../../models/OfficeLocation');
      const { UserPayrollDetail } = await import('../../models/UserPayrollDetail');
      const { BankDetail } = await import('../../models/BankDetail');

      const payrollDetail = await UserPayrollDetail.query().findOne({ user_id: payslipUser.id });
      const bankDetail = await BankDetail.query().findOne({ user_id: payslipUser.id });
      const department = payslipUser.department_id
        ? await Department.query().findById(payslipUser.department_id)
        : null;

      departmentName = (freshUser as any)?.department?.name || department?.name;
      if (!departmentName) {
        const fallbackDepartment = await Department.query()
          .alias('d')
          .join('users as u', 'u.department_id', 'd.id')
          .where('u.id', payslipUser.id)
          .select('d.name')
          .first();
        departmentName = (fallbackDepartment as any)?.name;
      }

      locationName =
        (freshUser as any)?.department?.location?.name ||
        (freshUser as any)?.department?.location?.address;
      if (!locationName && department?.location_id) {
        const deptLocation = await OfficeLocation.query().findById(department.location_id);
        locationName = deptLocation?.name || deptLocation?.address;
      }
      if (!departmentName) {
        const orgDepartment = await Department.query()
          .withGraphJoined('location')
          .where('departments.org_id', record.org_id)
          .whereNull('departments.deleted_at')
          .orderBy('departments.created_at', 'asc')
          .first();
        departmentName = orgDepartment?.name;
        if (!locationName) {
          locationName =
            (orgDepartment as any)?.location?.name || (orgDepartment as any)?.location?.address;
        }
      }

      panNumber = payrollDetail?.pan_number;
      uanNumber = payrollDetail?.uan_number;
      pfNumber = payrollDetail?.pf_number;
      bankAccount =
        bankDetail?.bank_name && bankDetail?.account_number
          ? `${bankDetail.bank_name} - ${bankDetail.account_number}`
          : bankDetail?.account_number;

      const payslipMetricsProcess = await computePayslipAttendanceMetrics({
        orgId: record.org_id,
        userId: payslipUser.id,
        payrollMonth: Number(record.payroll_month || 1),
        payrollYear: Number(record.payroll_year || new Date().getFullYear()),
      });
      standardDays = payslipMetricsProcess.standardDays;
      workingDays = payslipMetricsProcess.workingDays;
      lopDays = payslipMetricsProcess.lopDays;

      // Generate and upload payslip PDF
      const pdfUrl = await PayslipPdfService.generateAndUploadPayslip({
        payrollRecord: record,
        user: payslipUser,
        components: componentData,
        organizationName: orgName,
        organizationLogoUrl: orgLogoUrl,
        organizationEmail: orgEmail,
        organizationAddress: orgAddress,
        departmentName,
        locationName,
        panNumber,
        uanNumber,
        pfNumber,
        bankAccount,
        standardDays,
        workingDays,
        lopDays,
      });

      // Update record
      await record.$query().patch({
        payslip_pdf_url: pdfUrl,
        status: 'PROCESSED',
        processed_at: new Date(),
      });

      const updated = await PayrollRecord.query().findById(id);

      return res.json(updated!);
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to process payroll record',
      });
    }
  }

  /**
   * Get payroll dashboard summary (Total Salary, Allowances, Overtime, Incentives)
   * with percentage changes from previous month
   */
  static async getDashboardSummary(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = payrollDashboardSummaryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const org_id = req.user.org_id;
    const isManager = req.user.role === 'manager';
    const now = new Date();
    const month = parsed.data.month ?? now.getMonth() + 1;
    const year = parsed.data.year ?? now.getFullYear();

    try {
      if (AdminPayrollController.isFuturePayrollPeriod(month, year)) {
        return res.json({
          month,
          year,
          totals: {
            total_salary: 0,
            total_allowances: 0,
            total_overtime: 0,
            total_incentives: 0,
          },
          changes: {
            total_salary: 0,
            total_allowances: 0,
            total_overtime: 0,
            total_incentives: 0,
          },
        });
      }

      await ensurePayrollForMonthForOrganization(org_id, month, year);

      // Calculate previous month
      let prevMonth = month - 1;
      let prevYear = year;
      if (prevMonth < 1) {
        prevMonth = 12;
        prevYear = year - 1;
      }

      let managedDepartmentIds: string[] = [];
      if (isManager) {
        managedDepartmentIds = await getManagedDepartmentIds(org_id, req.user.id);
      }

      const summaryIncludedStatuses = ['PENDING', 'PROCESSED', 'ADJUSTED', 'PAID'] as const;

      // Get current month totals
      const currentMonthRecords = await PayrollRecord.query()
        .alias('pr')
        .leftJoin('users as u', 'u.id', 'pr.user_id')
        .where('pr.org_id', org_id)
        .where('pr.payroll_month', month)
        .where('pr.payroll_year', year)
        .whereNull('u.deleted_at')
        .whereIn('pr.status', summaryIncludedStatuses as readonly string[])
        .modify((qb) => {
          if (isManager) {
            qb.whereIn('u.department_id', managedDepartmentIds).where('u.role', 'employee');
          }
        })
        .select('pr.*');

      // Get previous month totals
      const previousMonthRecords = await PayrollRecord.query()
        .alias('pr')
        .leftJoin('users as u', 'u.id', 'pr.user_id')
        .where('pr.org_id', org_id)
        .where('pr.payroll_month', prevMonth)
        .where('pr.payroll_year', prevYear)
        .whereNull('u.deleted_at')
        .whereIn('pr.status', summaryIncludedStatuses as readonly string[])
        .modify((qb) => {
          if (isManager) {
            qb.whereIn('u.department_id', managedDepartmentIds).where('u.role', 'employee');
          }
        })
        .select('pr.*');

      // Calculate current month totals
      const currentTotalSalary = currentMonthRecords.reduce(
        (sum, record) => sum + Number(record.gross_salary || 0),
        0,
      );
      const currentTotalAllowances = currentMonthRecords.reduce(
        (sum, record) => sum + Number(record.allowance_amount || 0),
        0,
      );
      const currentTotalOvertime = currentMonthRecords.reduce(
        (sum, record) => sum + Number(record.overtime_amount || 0),
        0,
      );
      const currentTotalIncentives = currentMonthRecords.reduce(
        (sum, record) => sum + Number(record.incentive_amount || 0),
        0,
      );

      // Calculate previous month totals
      const previousTotalSalary = previousMonthRecords.reduce(
        (sum, record) => sum + Number(record.gross_salary || 0),
        0,
      );
      const previousTotalAllowances = previousMonthRecords.reduce(
        (sum, record) => sum + Number(record.allowance_amount || 0),
        0,
      );
      const previousTotalOvertime = previousMonthRecords.reduce(
        (sum, record) => sum + Number(record.overtime_amount || 0),
        0,
      );
      const previousTotalIncentives = previousMonthRecords.reduce(
        (sum, record) => sum + Number(record.incentive_amount || 0),
        0,
      );

      // Helper function to calculate percentage change
      const calculatePercentageChange = (current: number, previous: number): number => {
        if (previous === 0) {
          return current > 0 ? 100 : 0;
        }
        return ((current - previous) / previous) * 100;
      };

      // Helper function to format percentage
      const formatPercentage = (value: number): string => {
        const sign = value >= 0 ? '+' : '';
        return `${sign}${value.toFixed(1)}%`;
      };

      // Helper function to get month name
      const getMonthName = (monthNum: number): string => {
        const months = [
          'January',
          'February',
          'March',
          'April',
          'May',
          'June',
          'July',
          'August',
          'September',
          'October',
          'November',
          'December',
        ];
        return months[monthNum - 1] || '';
      };

      // Calculate percentage changes
      const salaryChange = calculatePercentageChange(currentTotalSalary, previousTotalSalary);
      const allowancesChange = calculatePercentageChange(
        currentTotalAllowances,
        previousTotalAllowances,
      );
      const overtimeChange = calculatePercentageChange(currentTotalOvertime, previousTotalOvertime);
      const incentivesChange = calculatePercentageChange(
        currentTotalIncentives,
        previousTotalIncentives,
      );

      return res.json({
        total_salary: {
          value: currentTotalSalary,
          change_percentage: salaryChange,
          change_display: formatPercentage(salaryChange),
          previous_month: getMonthName(prevMonth),
        },
        total_allowances: {
          value: currentTotalAllowances,
          change_percentage: allowancesChange,
          change_display: formatPercentage(allowancesChange),
          previous_month: getMonthName(prevMonth),
        },
        total_overtime: {
          value: currentTotalOvertime,
          change_percentage: overtimeChange,
          change_display: formatPercentage(overtimeChange),
          previous_month: getMonthName(prevMonth),
        },
        total_incentives: {
          value: currentTotalIncentives,
          change_percentage: incentivesChange,
          change_display: formatPercentage(incentivesChange),
          previous_month: getMonthName(prevMonth),
        },
      });
    } catch (error) {
      return res.status(500).json({
        message:
          error instanceof Error ? error.message : 'Failed to fetch payroll dashboard summary',
      });
    }
  }

  /**
   * Get payroll list for admin view (formatted for UI table)
   */
  static async getPayrollList(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Avoid stale 304/cached payroll totals after adjustments.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const parsed = payrollListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const {
      page,
      limit,
      month,
      year,
      start_date,
      end_date,
      from_date,
      to_date,
      user_id,
      status,
      search,
      sort_by,
      sort_dir,
    } = parsed.data;
    const rangeFrom = from_date ?? start_date;
    const rangeTo = to_date ?? end_date;
    const org_id = req.user.org_id;
    const isManager = req.user.role === 'manager';

    try {
      if (month && year) {
        if (AdminPayrollController.isFuturePayrollPeriod(month, year)) {
          return res.json({
            page,
            limit,
            total: 0,
            total_pages: 1,
            data: [],
          });
        }
        await ensurePayrollForMonthForOrganization(org_id, month, year);
      }

      let managedDepartmentIds: string[] = [];
      if (isManager) {
        managedDepartmentIds = await getManagedDepartmentIds(org_id, req.user.id);
      }

      // Base query with joins
      const baseQuery = PayrollRecord.query()
        .alias('pr')
        .leftJoin('users as u', 'u.id', 'pr.user_id')
        .leftJoin('departments as d', 'd.id', 'u.department_id')
        .leftJoin('salary_structures as ss', 'ss.id', 'pr.salary_structure_id')
        .where('pr.org_id', org_id)
        .whereNull('u.deleted_at')
        .modify((qb) => {
          if (isManager) {
            qb.whereIn('u.department_id', managedDepartmentIds).where('u.role', 'employee');
          }
        });

      // Filters
      if (month && year) {
        baseQuery.where('pr.payroll_month', month).where('pr.payroll_year', year);
      }
      if (user_id) {
        baseQuery.where('pr.user_id', user_id);
      }
      if (status) {
        baseQuery.where('pr.status', status);
      }
      if (rangeFrom && rangeTo) {
        baseQuery.whereRaw(
          'make_date(pr.payroll_year, pr.payroll_month, 1) between ?::date and ?::date',
          [rangeFrom, rangeTo],
        );
      }

      // Search (employee name, ID, email)
      if (search) {
        const term = `%${search}%`;
        baseQuery.where((qb) => {
          qb.where('u.first_name', 'ilike', term)
            .orWhere('u.last_name', 'ilike', term)
            .orWhere('u.employee_id', 'ilike', term)
            .orWhere('u.official_email', 'ilike', term)
            .orWhereRaw("CONCAT(u.first_name, ' ', u.last_name) ILIKE ?", [term]);
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
        baseQuery.orderBy('u.first_name', sort_dir === 'DESC' ? 'desc' : 'asc');
        baseQuery.orderBy('u.last_name', sort_dir === 'DESC' ? 'desc' : 'asc');
      } else if (sort_by === 'JOB_TITLE') {
        baseQuery.orderBy('u.designation', sort_dir === 'DESC' ? 'desc' : 'asc');
      } else if (sort_by === 'SALARY') {
        baseQuery.orderBy('pr.gross_salary', sort_dir === 'DESC' ? 'desc' : 'asc');
      } else if (sort_by === 'TOTAL') {
        // Approximate sort only: does not apply LOP proration or adjustment_incentives JSON.
        // Row `total` in the response uses resolvePayrollListDisplayAmounts (prorated net + adjustments).
        const direction = sort_dir === 'DESC' ? 'DESC' : 'ASC';
        baseQuery.orderByRaw(
          `COALESCE(pr.net_salary, 0) + COALESCE(pr.incentive_amount, 0) - COALESCE(pr.total_deductions, 0) ${direction}`,
        );
      } else if (sort_by === 'STATUS') {
        baseQuery.orderBy('pr.status', sort_dir === 'DESC' ? 'desc' : 'asc');
      } else {
        // Default: DATE (most recent first)
        baseQuery.orderBy('pr.payroll_year', 'desc');
        baseQuery.orderBy('pr.payroll_month', 'desc');
        baseQuery.orderBy('pr.created_at', 'desc');
      }

      // Secondary sort for consistency
      baseQuery.orderBy('pr.created_at', 'desc');

      // Fetch data
      const rows = await baseQuery
        .clone()
        .select(
          'pr.id',
          'pr.user_id',
          'pr.payroll_month',
          'pr.payroll_year',
          'pr.gross_salary',
          'pr.allowance_amount',
          'pr.overtime_amount',
          'pr.incentive_amount',
          'pr.bonus_amount',
          'pr.pf_contribution',
          'pr.professional_tax',
          'pr.adjustment_incentives',
          'pr.adjustment_extra_deductions',
          'pr.total_earnings',
          'pr.total_deductions',
          'pr.net_salary',
          'pr.component_breakdown',
          'pr.status',
          'pr.payslip_pdf_url',
          'ss.employer_total_contributions as employer_total_contributions',
          'u.employee_id',
          'u.first_name',
          'u.last_name',
          'u.profile_image_url',
          'u.designation',
          'd.name as department_name',
        )
        .limit(limit)
        .offset(offset);

      // Helper to format date as ISO date string (YYYY-MM-DD)
      const formatPayrollDate = (month: number, year: number): string => {
        const monthStr = String(month).padStart(2, '0');
        return `${year}-${monthStr}-01`;
      };

      const displayAmountsList = await resolvePayrollListDisplayAmountsBatch(
        rows.map((r: any) => payrollRecordToPayslipPayPeriodInput(r, org_id, String(r.user_id))),
      );

      const data = rows.map((r: any, index: number) => {
        const display = displayAmountsList[index];
        const salary = Number(r.gross_salary ?? 0);
        const allowances = Number(r.allowance_amount ?? 0);
        const overtime = Number(r.overtime_amount ?? 0);

        return {
          id: r.id,
          name: {
            full_name: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(),
            employee_id: r.employee_id ?? null,
            profile_image_url: r.profile_image_url ?? null,
          },
          job_title: {
            title: r.designation ?? null,
            department: r.department_name ?? null,
          },
          // Base salary (gross for the period)
          salary,
          // Always return numeric values (0 instead of null) for monetary columns
          allowances,
          overtime,
          // Adjustment-only aggregates (not prorated)
          incentives: display.incentives,
          deductions: display.deductions,
          // Net payable: LOP-prorated base net + adjustments
          total: display.total,
          net_salary: display.net_salary,
          status: r.status,
          date: formatPayrollDate(r.payroll_month, r.payroll_year),
          payslip_url: r.payslip_pdf_url ?? null,
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
        message: error instanceof Error ? error.message : 'Failed to fetch payroll list',
      });
    }
  }

  /**
   * Get payroll adjustment data for a payroll record (for adjust salary modal)
   */
  static async getPayrollAdjustment(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id: payrollRecordId } = req.params;
    const org_id = req.user.org_id;

    try {
      // Get payroll record with user info
      const payrollRecord = await PayrollRecord.query()
        .withGraphJoined('[user.department]')
        .where('payroll_records.id', payrollRecordId)
        .where('payroll_records.org_id', org_id)
        .first();

      if (!payrollRecord) {
        return res.status(404).json({ message: 'Payroll record not found' });
      }

      const user = (payrollRecord as any).user;
      if (!user) {
        return res.status(404).json({ message: 'Employee not found' });
      }

      const userId = payrollRecord.user_id;
      const month = payrollRecord.payroll_month;
      const year = payrollRecord.payroll_year;

      // Calculate date range for the month
      const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
      const lastDay = new Date(year, month, 0).getDate();
      const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

      // Get attendance logs for the month
      const attendanceLogs = await AttendanceLog.query()
        .where('org_id', org_id)
        .where('user_id', userId)
        .whereBetween('date', [startDate, endDate])
        .whereNotNull('clock_in_time')
        .whereNotNull('clock_out_time');

      // Calculate worked days (days with both clock in and clock out)
      const workedDays = attendanceLogs.length;

      // Calculate total working days in month (excluding weekends - simplified)
      const totalDaysInMonth = lastDay;
      let totalWorkingDays = 0;
      for (let day = 1; day <= totalDaysInMonth; day++) {
        const date = new Date(year, month - 1, day);
        const dayOfWeek = date.getDay();
        // Count weekdays (Monday=1 to Friday=5)
        if (dayOfWeek >= 1 && dayOfWeek <= 5) {
          totalWorkingDays++;
        }
      }

      const totalOvertimeHours = await computeMonthlyShiftBasedOvertimeHours({
        orgId: org_id,
        userId,
        monthStart: startDate,
        monthEnd: endDate,
      });

      const unpaidDays = Math.max(0, totalWorkingDays - workedDays);

      const display = await resolvePayrollListDisplayAmounts(
        payrollRecordToPayslipPayPeriodInput(payrollRecord, org_id, userId),
      );

      // Return only items explicitly added via PUT /adjust (persisted in adjustment_* arrays).
      // Do not append fixed items (e.g., PF/PT from onboarding/finance edits) as list entries.
      const incentives: Array<{ name: string; amount: number }> = Array.isArray(
        (payrollRecord as any).adjustment_incentives,
      )
        ? (((payrollRecord as any).adjustment_incentives as Array<{
            name: string;
            amount: number;
          }>) ?? [])
        : [];

      const extraDeductions: Array<{ name: string; amount: number }> = Array.isArray(
        (payrollRecord as any).adjustment_extra_deductions,
      )
        ? (((payrollRecord as any).adjustment_extra_deductions as Array<{
            name: string;
            amount: number;
          }>) ?? [])
        : [];

      return res.json({
        employee: {
          name: `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim(),
          department: (user as any).department?.name ?? null,
        },
        summary: {
          worked_days: workedDays,
          total_working_days: totalWorkingDays,
          overtime_hours: totalOvertimeHours,
          unpaid_days: unpaidDays,
        },
        net_payable: {
          salary_per_month: display.total,
          fixed_salary: display.net_salary,
          added_amount: display.incentives,
          deductions: display.deductions,
        },
        incentives: incentives,
        extra_deductions: extraDeductions,
      });
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to fetch payroll adjustment data',
      });
    }
  }

  /**
   * Update payroll adjustment for an employee
   */
  static async updatePayrollAdjustment(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = payrollAdjustmentUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const org_id = req.user.org_id;

    try {
      // Get payroll record
      const { id: payrollRecordId } = req.params;
      let payrollRecord = await PayrollRecord.query()
        .where('id', payrollRecordId)
        .where('org_id', org_id)
        .first();

      if (!payrollRecord) {
        return res.status(404).json({ message: 'Payroll record not found' });
      }

      const updateData: any = {};

      // Update salary per month (net_salary)
      // IMPORTANT:
      // In the adjust flow, the client often sends `salary_per_month` as a derived display value.
      // We must NOT persist that derived net when the request is modifying incentives/deductions,
      // otherwise deleting/updating adjustments would mutate the stored `net_salary`.
      const isAdjustmentPayload =
        parsed.data.incentives !== undefined || parsed.data.extra_deductions !== undefined;
      const allowNetSalaryPatch =
        parsed.data.salary_per_month !== undefined && !isAdjustmentPayload;
      if (allowNetSalaryPatch) {
        updateData.net_salary = parsed.data.salary_per_month;
      }

      // IMPORTANT:
      // `fixed_salary` in the adjust modal represents the employee's fixed NET salary baseline.
      // It must NOT overwrite `gross_salary` on the payroll record.

      // NOTE: We intentionally do NOT patch allowance_amount from added_amount.
      // "added_amount" is a derived display field (allowances + overtime + incentives + bonus).
      // The underlying allowance_amount and base totals remain the baseline.

      // 1) Derive baseline totals (before previous adjustments) using stored adjustment arrays
      const previousIncentives =
        Array.isArray((payrollRecord as any).adjustment_incentives) &&
        (payrollRecord as any).adjustment_incentives.length > 0
          ? ((payrollRecord as any).adjustment_incentives as Array<{
              name: string;
              amount: number;
            }>)
          : [];
      const previousExtraDeductions =
        Array.isArray((payrollRecord as any).adjustment_extra_deductions) &&
        (payrollRecord as any).adjustment_extra_deductions.length > 0
          ? ((payrollRecord as any).adjustment_extra_deductions as Array<{
              name: string;
              amount: number;
            }>)
          : [];

      const previousIncentiveTotal = previousIncentives.reduce(
        (sum, item) => sum + Number(item.amount || 0),
        0,
      );
      const previousExtraDeductionTotal = previousExtraDeductions.reduce(
        (sum, item) => sum + Number(item.amount || 0),
        0,
      );

      const existingTotalEarnings = Number(payrollRecord?.total_earnings ?? 0);
      const existingTotalDeductions = Number(payrollRecord?.total_deductions ?? 0);

      const baseEarnings = existingTotalEarnings - previousIncentiveTotal;

      // 2) Apply incentives
      // If incentives is omitted in the request body, keep existing values (do not wipe).
      const incomingIncentives =
        parsed.data.incentives !== undefined ? parsed.data.incentives : previousIncentives;
      let overtimeAmount = 0;
      let incentiveAmount = 0;
      let bonusAmount = 0;

      for (const incentive of incomingIncentives) {
        const name = incentive.name.toLowerCase();
        if (name.includes('overtime')) {
          overtimeAmount += incentive.amount;
        } else if (name.includes('bonus')) {
          bonusAmount += incentive.amount;
        } else {
          incentiveAmount += incentive.amount;
        }
      }

      updateData.overtime_amount = overtimeAmount;
      updateData.incentive_amount = incentiveAmount;
      updateData.bonus_amount = bonusAmount;
      // Persist full incentive breakdown only if caller supplied it
      if (parsed.data.incentives !== undefined) {
        updateData.adjustment_incentives = incomingIncentives;
      }

      const newIncentiveTotal = incomingIncentives.reduce(
        (sum, item) => sum + Number(item.amount || 0),
        0,
      );

      // 3) Apply extra deductions
      // If extra_deductions is omitted in the request body, keep existing values (do not wipe).
      const incomingExtraDeductions =
        parsed.data.extra_deductions !== undefined
          ? parsed.data.extra_deductions
          : previousExtraDeductions;
      let pfContribution = 0;
      let professionalTax = 0;

      for (const deduction of incomingExtraDeductions) {
        const amount = Number(deduction.amount || 0);
        const name = deduction.name.toLowerCase();

        if (name.includes('pf')) {
          pfContribution += amount;
        } else if (name.includes('professional')) {
          professionalTax += amount;
        }
      }

      updateData.pf_contribution = pfContribution || null;
      updateData.professional_tax = professionalTax || null;
      // Persist full extra deductions breakdown only if caller supplied it
      if (parsed.data.extra_deductions !== undefined) {
        updateData.adjustment_extra_deductions = incomingExtraDeductions;
      }

      const newExtraDeductionTotal = incomingExtraDeductions.reduce(
        (sum, item) => sum + Number(item.amount || 0),
        0,
      );

      // If legacy records stored extra deductions only in total_deductions (without a breakdown),
      // subtracting "previous adjustment arrays" won't remove them (because arrays are empty).
      // For the adjust modal, "extra_deductions" should behave as replacement, not stacking.
      const existingExtraDeductionFromColumns =
        Number((payrollRecord as any).pf_contribution || 0) +
        Number((payrollRecord as any).professional_tax || 0);
      const existingExtraDeductionKnown = Math.max(
        Number(existingExtraDeductionFromColumns || 0),
        Number(previousExtraDeductionTotal || 0),
      );

      let baseDeductions = existingTotalDeductions - existingExtraDeductionKnown;
      const looksLikeLegacyDoubleCountWithArrays =
        existingExtraDeductionFromColumns > 0 &&
        previousExtraDeductionTotal > 0 &&
        Math.abs(existingExtraDeductionFromColumns - previousExtraDeductionTotal) < 0.01 &&
        Math.abs(
          existingTotalDeductions -
            (existingExtraDeductionFromColumns + previousExtraDeductionTotal),
        ) < 0.01 &&
        newExtraDeductionTotal > 0;
      const looksLikeLegacyDoubleCountExtraOnly =
        previousExtraDeductions.length === 0 &&
        existingExtraDeductionFromColumns > 0 &&
        Math.abs(existingTotalDeductions - existingExtraDeductionFromColumns * 2) < 0.01 &&
        newExtraDeductionTotal > 0 &&
        Math.abs(newExtraDeductionTotal - existingExtraDeductionFromColumns) < 0.01;
      const shouldTreatExistingAsExtraOnly =
        existingExtraDeductionKnown === 0 &&
        previousExtraDeductions.length === 0 &&
        newExtraDeductionTotal > 0 &&
        existingTotalDeductions === newExtraDeductionTotal;
      if (
        shouldTreatExistingAsExtraOnly ||
        looksLikeLegacyDoubleCountExtraOnly ||
        looksLikeLegacyDoubleCountWithArrays
      ) {
        baseDeductions = 0;
      }
      baseDeductions = Math.max(0, Number(baseDeductions || 0));

      // 4) Recompute totals from baseline + new adjustments
      const totalEarnings = baseEarnings + newIncentiveTotal;
      const totalDeductions = baseDeductions + newExtraDeductionTotal;

      // Calculate net salary: use provided salary_per_month if given, otherwise calculate
      // If we are processing an adjustment payload, keep the stored net salary unchanged.
      const netSalary = isAdjustmentPayload
        ? Number((payrollRecord as any)?.net_salary ?? 0)
        : (updateData.net_salary ?? totalEarnings - totalDeductions);

      updateData.total_earnings = totalEarnings;
      updateData.total_deductions = totalDeductions;
      // Only persist net salary when explicitly allowed.
      if (!isAdjustmentPayload) {
        updateData.net_salary = netSalary;
      }

      // Update existing record
      await payrollRecord.$query().patch(updateData);

      // Ensure payslip PDF is updated after adjustment
      try {
        await AdminPayrollController.regeneratePayslipPdfUrlForRecord(org_id, payrollRecord.id);
      } catch (pdfError) {
        logger.error(
          `Failed to regenerate payslip PDF after adjustment for payroll record ${payrollRecord.id}: ${pdfError instanceof Error ? pdfError.message : 'Unknown error'}`,
        );
      }

      const updated = await PayrollRecord.query().findById(payrollRecord.id);
      return res.json(updated);
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to update payroll adjustment',
      });
    }
  }

  /**
   * Download payslip PDF for a payroll record (Admin/HR only)
   */
  static async downloadPayslip(req: Request, res: Response): Promise<Response | void> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    const org_id = req.user.org_id;

    try {
      // Find payroll record with user info
      const payrollRecord = await PayrollRecord.query()
        .withGraphJoined('user')
        .where('payroll_records.id', id)
        .where('payroll_records.org_id', org_id)
        .first();

      if (!payrollRecord) {
        return res.status(404).json({ message: 'Payroll record not found' });
      }

      // Get user from graph join
      const user = (payrollRecord as any).user as User;
      if (!user) {
        return res.status(404).json({ message: 'User not found for payroll record' });
      }

      // Get salary components from component_breakdown
      // Filter out empty strings and invalid UUIDs to prevent SQL errors
      const components = await AdminPayrollController.buildPayslipComponentsIncludingAdjustments(
        org_id,
        payrollRecord as any,
      );

      // Get organization details
      let orgName: string | undefined;
      let orgEmail: string | undefined;
      let orgAddress: string | undefined;
      let orgPhone: string | undefined;
      let orgLogoUrl: string | undefined;
      let departmentName: string | undefined;
      let locationName: string | undefined;
      let panNumber: string | undefined;
      let uanNumber: string | undefined;
      let pfNumber: string | undefined;
      let bankAccount: string | undefined;
      let standardDays: number | undefined;
      let workingDays: number | undefined;
      let lopDays: number | undefined;
      if (org_id) {
        const { Organization } = await import('../../models/Organization');
        const { OfficeLocation } = await import('../../models/OfficeLocation');
        const org = await Organization.query().findById(org_id);
        if (org) {
          orgName = org.name;
          orgEmail = org.contact_email;
          orgLogoUrl = org.logo_url;
          // Get primary office location for address
          const officeLocation = await OfficeLocation.query().where('org_id', org_id).first();
          if (officeLocation?.address) {
            orgAddress = officeLocation.address;
          }
          // Phone would need to be added to Organization or OfficeLocation model
          // For now, we'll leave it undefined
        }
      }

      const { Department } = await import('../../models/Department');
      const { UserPayrollDetail } = await import('../../models/UserPayrollDetail');
      const { BankDetail } = await import('../../models/BankDetail');
      const freshUser = await User.query()
        .findById(user.id)
        .withGraphJoined('[department.location]');
      const payslipUser = (freshUser || user) as User;
      const department = payslipUser.department_id
        ? await Department.query().findById(payslipUser.department_id)
        : null;
      const payrollDetail = await UserPayrollDetail.query().findOne({ user_id: payslipUser.id });
      const bankDetail = await BankDetail.query().findOne({ user_id: payslipUser.id });

      departmentName = (freshUser as any)?.department?.name || department?.name;
      if (!departmentName) {
        const fallbackDepartment = await Department.query()
          .alias('d')
          .join('users as u', 'u.department_id', 'd.id')
          .where('u.id', payslipUser.id)
          .select('d.name')
          .first();
        departmentName = (fallbackDepartment as any)?.name;
      }
      locationName =
        (freshUser as any)?.department?.location?.name ||
        (freshUser as any)?.department?.location?.address;
      if (!locationName && department?.location_id) {
        const { OfficeLocation } = await import('../../models/OfficeLocation');
        const deptLocation = await OfficeLocation.query().findById(department.location_id);
        locationName = deptLocation?.name || deptLocation?.address;
      }
      if (!departmentName) {
        const orgDepartment = await Department.query()
          .withGraphJoined('location')
          .where('departments.org_id', payrollRecord.org_id)
          .whereNull('departments.deleted_at')
          .orderBy('departments.created_at', 'asc')
          .first();
        departmentName = orgDepartment?.name;
        if (!locationName) {
          locationName =
            (orgDepartment as any)?.location?.name || (orgDepartment as any)?.location?.address;
        }
      }
      panNumber = payrollDetail?.pan_number;
      uanNumber = payrollDetail?.uan_number;
      pfNumber = payrollDetail?.pf_number;
      bankAccount =
        bankDetail?.bank_name && bankDetail?.account_number
          ? `${bankDetail.bank_name} - ${bankDetail.account_number}`
          : bankDetail?.account_number;

      const payslipMetricsDownload = await computePayslipAttendanceMetrics({
        orgId: payrollRecord.org_id,
        userId: payslipUser.id,
        payrollMonth: Number(payrollRecord.payroll_month || 1),
        payrollYear: Number(payrollRecord.payroll_year || new Date().getFullYear()),
      });
      standardDays = payslipMetricsDownload.standardDays;
      workingDays = payslipMetricsDownload.workingDays;
      lopDays = payslipMetricsDownload.lopDays;

      // Generate PDF buffer
      const pdfBuffer = await PayslipPdfService.generatePayslipBuffer({
        payrollRecord,
        user: payslipUser,
        components: components,
        organizationName: orgName,
        organizationLogoUrl: orgLogoUrl,
        organizationEmail: orgEmail,
        organizationAddress: orgAddress,
        organizationPhone: orgPhone,
        departmentName,
        locationName,
        panNumber,
        uanNumber,
        pfNumber,
        bankAccount,
        standardDays,
        workingDays,
        lopDays,
      });

      // Generate filename
      const monthStr = String(payrollRecord.payroll_month).padStart(2, '0');
      const filename = `payslip-${payslipUser.employee_id || payslipUser.id}-${payrollRecord.payroll_year}-${monthStr}.pdf`;

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(pdfBuffer);
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to generate payslip',
      });
    }
  }
}

/**
 * Process Excel payroll file (async helper)
 */
async function processExcelPayrollFile(
  uploadId: string,
  fileBuffer: Buffer,
  orgId: string,
  month: number,
  year: number,
): Promise<void> {
  try {
    await PayrollUpload.query().findById(uploadId).patch({ status: 'PROCESSING' });

    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet);

    let processed = 0;
    let failed = 0;
    const errors: Array<{ row?: number; error: string }> = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i] as any;
      try {
        // Expected columns: employee_id, gross_salary, net_salary, etc.
        const employeeId = row.employee_id || row['Employee ID'] || row['EmployeeID'];
        if (!employeeId) {
          failed++;
          errors.push({ row: i + 2, error: 'Missing employee_id' });
          continue;
        }

        const user = await User.query().findOne({
          org_id: orgId,
          employee_id: String(employeeId),
        });

        if (!user) {
          failed++;
          errors.push({ row: i + 2, error: `User not found: ${employeeId}` });
          continue;
        }

        // Create or update payroll record
        const grossSalary = parseFloat(
          row.gross_salary || row['Gross Salary'] || row['GrossSalary'] || 0,
        );
        const netSalary = parseFloat(row.net_salary || row['Net Salary'] || row['NetSalary'] || 0);
        const totalEarnings = parseFloat(
          row.total_earnings || row['Total Earnings'] || row['TotalEarnings'] || grossSalary,
        );
        const totalDeductions = parseFloat(
          row.total_deductions || row['Total Deductions'] || row['TotalDeductions'] || 0,
        );

        await PayrollRecord.query()
          .insert({
            org_id: orgId,
            user_id: user.id,
            payroll_month: month,
            payroll_year: year,
            gross_salary: grossSalary,
            net_salary: netSalary,
            total_earnings: totalEarnings,
            total_deductions: totalDeductions,
            component_breakdown: {},
            status: 'PENDING',
          } as any)
          .onConflict(['user_id', 'payroll_month', 'payroll_year'])
          .merge({
            gross_salary: grossSalary,
            net_salary: netSalary,
            total_earnings: totalEarnings,
            total_deductions: totalDeductions,
          });

        processed++;
      } catch (error) {
        failed++;
        errors.push({
          row: i + 2,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    await PayrollUpload.query()
      .findById(uploadId)
      .patch({
        status:
          failed > 0 && processed > 0
            ? 'PARTIALLY_PROCESSED'
            : processed > 0
              ? 'COMPLETED'
              : 'FAILED',
        processed_records: processed,
        failed_records: failed,
        total_records: data.length,
        processing_errors: errors,
        processed_at: new Date(),
      });
  } catch (error) {
    await PayrollUpload.query()
      .findById(uploadId)
      .patch({
        status: 'FAILED',
        processing_errors: [{ error: error instanceof Error ? error.message : 'Unknown error' }],
        processed_at: new Date(),
      });
  }
}
