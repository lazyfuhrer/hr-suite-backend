import type { Request, Response } from 'express';

import { User } from '../../models/User';
import { SalaryStructure } from '../../models/SalaryStructure';
import { EmployeeEmploymentDetail } from '../../models/EmployeeEmploymentDetail';
import { getManagedDepartmentIds } from '../../utils/department-manager.utils';
import { createAppraisalBodySchema, appraisalHistoryQuerySchema } from '../../validators';
import { applyEmployeePayrollFinanceUpdate } from '../../services/employee-payroll-finance.service';

const round2 = (val: number): number => Math.round(val * 100) / 100;

export class AppraisalController {
  static async createAppraisal(req: Request, res: Response): Promise<Response> {
    if (!req.user) return res.status(401).json({ message: 'Unauthorized' });

    const parsed = createAppraisalBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { start_from, hike_percentage, finance } = parsed.data;
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ message: 'userId is required' });

    const org_id = req.user.org_id;

    const targetUser = await User.query()
      .where('id', userId)
      .where('org_id', org_id)
      .whereNull('deleted_at')
      .first();
    if (!targetUser) return res.status(404).json({ message: 'User not found' });

    // Manager scoping: allow if employee is unassigned (department_id is NULL),
    // else employee must belong to one of manager-managed departments.
    if (req.user.role === 'manager') {
      if (targetUser.department_id) {
        const managedDepartmentIds = await getManagedDepartmentIds(org_id, req.user.id);
        if (!managedDepartmentIds.includes(String(targetUser.department_id))) {
          return res.status(403).json({ message: 'Forbidden' });
        }
      }
    }

    const [yearStr, monthStr] = start_from.split('-');
    const year = Number(yearStr);
    const month = Number(monthStr);
    const effectiveFrom = new Date(year, month - 1, 1);

    const now = new Date();
    const sync_current_month = year === now.getFullYear() && month === now.getMonth() + 1;

    const result = await applyEmployeePayrollFinanceUpdate({
      userId,
      org_id,
      finance,
      effective_from: effectiveFrom,
      hike_percentage,
      sync_current_month,
    });

    return res.status(201).json({
      message: 'Appraisal created successfully',
      data: {
        user_id: userId,
        start_from,
        salary_structure_id: result.salary_structure_id,
        effective_from: result.effective_from.toISOString(),
        annual_ctc: result.annual_ctc,
        hike_percentage: hike_percentage ?? null,
      },
    });
  }

  static async getAppraisalHistory(req: Request, res: Response): Promise<Response> {
    if (!req.user) return res.status(401).json({ message: 'Unauthorized' });

    const { userId } = req.params;
    if (!userId) return res.status(400).json({ message: 'userId is required' });

    const parsed = appraisalHistoryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const org_id = req.user.org_id;
    const targetUser = await User.query()
      .where('id', userId)
      .where('org_id', org_id)
      .whereNull('deleted_at')
      .first();
    if (!targetUser) return res.status(404).json({ message: 'User not found' });

    if (req.user.role === 'manager') {
      if (targetUser.department_id) {
        const managedDepartmentIds = await getManagedDepartmentIds(org_id, req.user.id);
        if (!managedDepartmentIds.includes(String(targetUser.department_id))) {
          return res.status(403).json({ message: 'Forbidden' });
        }
      }
    }

    const { page, limit } = parsed.data;

    const allStructures = await SalaryStructure.query()
      .where('user_id', userId)
      .where('org_id', org_id)
      .whereNull('deleted_at')
      .orderBy('effective_from', 'asc');

    const total = allStructures.length;
    const startIdx = (page - 1) * limit;
    const paged = allStructures.slice(startIdx, startIdx + limit);

    const items = paged.map((curr, idx) => {
      const prev = paged[idx - 1] ?? null;
      const prevAnnual = prev ? round2(prev.gross_salary * 12) : null;
      const currAnnual = round2(curr.gross_salary * 12);
      let hikePercentage: number | null = null;
      if (prev && prev.gross_salary > 0) {
        hikePercentage = round2(
          ((curr.gross_salary - prev.gross_salary) / prev.gross_salary) * 100,
        );
      }

      const effective =
        curr.effective_from instanceof Date ? curr.effective_from : new Date(curr.effective_from);
      // `effective_from` is stored as a DATE in Postgres; timezone conversions can shift ISO strings.
      // Log both UTC and local-derived month/year so we can pick the correct one for UI.
      const yearLocal = effective.getFullYear();
      const monthLocal = effective.getMonth() + 1;

      const year = yearLocal;
      const month = monthLocal;
      return {
        month,
        year,
        effective_from: curr.effective_from,
        prev_ctc_annual: prevAnnual,
        current_ctc_annual: currAnnual,
        hike_percentage: hikePercentage,
      };
    });

    return res.json({
      items,
      total,
      page,
      limit,
    });
  }

  /**
   * Dedicated GET to fetch the current CTC and the employee's currently-active salary structure.
   * This is the baseline UI payload required by the appraisal creation POST.
   */
  static async getCurrentSalaryStructure(req: Request, res: Response): Promise<Response> {
    if (!req.user) return res.status(401).json({ message: 'Unauthorized' });

    const { userId } = req.params;
    if (!userId) return res.status(400).json({ message: 'userId is required' });

    const org_id = req.user.org_id;

    const targetUser = await User.query()
      .where('id', userId)
      .where('org_id', org_id)
      .whereNull('deleted_at')
      .first();
    if (!targetUser) return res.status(404).json({ message: 'User not found' });

    if (req.user.role === 'manager') {
      if (targetUser.department_id) {
        const managedDepartmentIds = await getManagedDepartmentIds(org_id, req.user.id);
        if (!managedDepartmentIds.includes(String(targetUser.department_id))) {
          return res.status(403).json({ message: 'Forbidden' });
        }
      }
    }

    try {
      const employmentDetails = await EmployeeEmploymentDetail.query()
        .where('user_id', userId)
        .first();

      // For the appraisal UI baseline, return the latest effective structure (even if it is not
      // `is_active` for current-month payroll).
      const salaryStructure = await SalaryStructure.query()
        .where({ user_id: userId, org_id })
        .whereNull('deleted_at')
        .orderBy('effective_from', 'desc')
        .first();

      const annualCtcRaw = employmentDetails?.annual_ctc;
      // Postgres NUMERIC/DECIMAL often comes back as string via drivers; coerce safely.
      const annual_ctc =
        annualCtcRaw === null || annualCtcRaw === undefined
          ? undefined
          : round2(Number(annualCtcRaw));

      const computedAnnualCTC = salaryStructure
        ? round2(Number(salaryStructure.gross_salary) * 12)
        : null;
      const finalAnnualCTC = annual_ctc ?? computedAnnualCTC ?? null;

      const effective = salaryStructure?.effective_from
        ? salaryStructure.effective_from instanceof Date
          ? salaryStructure.effective_from
          : new Date(salaryStructure.effective_from)
        : null;

      const effectiveMonth = effective ? effective.getMonth() + 1 : null;
      const effectiveYear = effective ? effective.getFullYear() : null;

      const coercedSalaryStructure = salaryStructure
        ? {
            ...salaryStructure,
            gross_salary:
              salaryStructure.gross_salary !== null && salaryStructure.gross_salary !== undefined
                ? round2(Number(salaryStructure.gross_salary))
                : salaryStructure.gross_salary,
            net_salary:
              salaryStructure.net_salary !== null && salaryStructure.net_salary !== undefined
                ? round2(Number(salaryStructure.net_salary))
                : salaryStructure.net_salary,
            component_breakdown: Object.fromEntries(
              Object.entries(salaryStructure.component_breakdown || {}).map(([k, v]) => [
                k,
                Number.isFinite(Number(v)) ? round2(Number(v)) : v,
              ]),
            ),
          }
        : null;

      return res.json({
        annual_ctc: finalAnnualCTC,
        salary_structure: coercedSalaryStructure,
        current_effective_from_month: effectiveMonth,
        current_effective_from_year: effectiveYear,
      });
    } catch {
      return res.status(500).json({
        message: 'Failed to fetch current appraisal baseline',
      });
    }
  }
}
