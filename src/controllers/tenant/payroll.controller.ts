import type { Request, Response } from 'express';
import { PayrollRecord } from '../../models/PayrollRecord';
import { User } from '../../models/User';
import { UserPayrollDetail } from '../../models/UserPayrollDetail';
import { SalaryComponent } from '../../models/SalaryComponent';
import { AttendanceLog } from '../../models/AttendanceLog';
import { LeaveRequest } from '../../models/LeaveRequest';
import { PayslipPdfService } from '../../services/payslip-pdf.service';
import { computePayslipAttendanceMetrics } from '../../utils/payslip-attendance-metrics.utils';
import {
  payrollRecordToPayslipPayPeriodInput,
  resolvePayrollListDisplayAmounts,
  resolvePayrollListDisplayAmountsBatch,
} from '../../utils/payroll-list-display.utils';
import {
  payrollMonthYearQuerySchema,
  updateUserPayrollDetailSchema,
  myPayQuerySchema,
  myPayHistoryQuerySchema,
} from '../../validators';

export class PayrollController {
  /**
   * Get user's payroll details (PF, PAN, etc.)
   */
  static async getMyPayrollDetails(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    try {
      let payrollDetail = await UserPayrollDetail.query().findOne({ user_id: req.user.id });

      if (!payrollDetail) {
        // Create empty record if doesn't exist
        payrollDetail = await UserPayrollDetail.query().insert({
          user_id: req.user.id,
        });
      }

      return res.json({
        id: payrollDetail.id,
        pan_number: payrollDetail.pan_number,
        aadhaar_number: payrollDetail.aadhaar_number,
        pf_number: payrollDetail.pf_number,
        uan_number: payrollDetail.uan_number,
        esi_number: payrollDetail.esi_number,
        tax_saving_investments: payrollDetail.tax_saving_investments,
        declared_tax: payrollDetail.declared_tax,
        updated_at: payrollDetail.updated_at,
      });
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to fetch payroll details',
      });
    }
  }

  /**
   * Update user's payroll details
   */
  static async updateMyPayrollDetails(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = updateUserPayrollDetailSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    try {
      let payrollDetail = await UserPayrollDetail.query().findOne({ user_id: req.user.id });

      let updatedDetail: UserPayrollDetail;
      if (payrollDetail) {
        const patchData: any = {};
        if (parsed.data.pan_number !== undefined) patchData.pan_number = parsed.data.pan_number;
        if (parsed.data.aadhaar_number !== undefined)
          patchData.aadhaar_number = parsed.data.aadhaar_number;
        if (parsed.data.pf_number !== undefined) patchData.pf_number = parsed.data.pf_number;
        if (parsed.data.uan_number !== undefined) patchData.uan_number = parsed.data.uan_number;
        if (parsed.data.esi_number !== undefined) patchData.esi_number = parsed.data.esi_number;
        if (parsed.data.tax_saving_investments !== undefined)
          patchData.tax_saving_investments = parsed.data.tax_saving_investments;
        if (parsed.data.declared_tax !== undefined)
          patchData.declared_tax = parsed.data.declared_tax;
        await payrollDetail.$query().patch(patchData);
        const reloaded = await UserPayrollDetail.query().findById(payrollDetail.id);
        if (!reloaded) {
          return res.status(500).json({ message: 'Failed to reload payroll details' });
        }
        updatedDetail = reloaded;
      } else {
        const insertData: any = { user_id: req.user.id };
        if (parsed.data.pan_number !== undefined) insertData.pan_number = parsed.data.pan_number;
        if (parsed.data.aadhaar_number !== undefined)
          insertData.aadhaar_number = parsed.data.aadhaar_number;
        if (parsed.data.pf_number !== undefined) insertData.pf_number = parsed.data.pf_number;
        if (parsed.data.uan_number !== undefined) insertData.uan_number = parsed.data.uan_number;
        if (parsed.data.esi_number !== undefined) insertData.esi_number = parsed.data.esi_number;
        if (parsed.data.tax_saving_investments !== undefined)
          insertData.tax_saving_investments = parsed.data.tax_saving_investments;
        if (parsed.data.declared_tax !== undefined)
          insertData.declared_tax = parsed.data.declared_tax;
        updatedDetail = await UserPayrollDetail.query().insert(insertData);
      }

      return res.json({
        id: updatedDetail.id,
        pan_number: updatedDetail.pan_number,
        aadhaar_number: updatedDetail.aadhaar_number,
        pf_number: updatedDetail.pf_number,
        uan_number: updatedDetail.uan_number,
        esi_number: updatedDetail.esi_number,
        tax_saving_investments: updatedDetail.tax_saving_investments,
        declared_tax: updatedDetail.declared_tax,
        updated_at: updatedDetail.updated_at,
      });
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to update payroll details',
      });
    }
  }

  /**
   * Download salary slip PDF
   * Supports both payroll record ID (via :id param) and month/year query params
   */
  static async downloadSalarySlip(req: Request, res: Response): Promise<Response | void> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;

    try {
      let payrollRecord: PayrollRecord;

      // If ID is provided, fetch by ID
      if (id) {
        const record = await PayrollRecord.query()
          .withGraphJoined('user')
          .where('payroll_records.id', id)
          .where('payroll_records.user_id', req.user.id)
          .first();

        if (!record) {
          return res.status(404).json({ message: 'Payroll record not found' });
        }
        payrollRecord = record;
      } else {
        // Otherwise, use month/year query params
        const parsed = payrollMonthYearQuerySchema.safeParse(req.query);
        if (!parsed.success) {
          return res.status(400).json({
            message: 'Invalid query parameters. Provide either payroll record ID or month/year.',
            errors: parsed.error.flatten().fieldErrors,
          });
        }

        const { month, year } = parsed.data;
        const currentDate = new Date();
        const payrollMonth = month ?? currentDate.getMonth() + 1;
        const payrollYear = year ?? currentDate.getFullYear();

        const record = await PayrollRecord.query().withGraphJoined('user').findOne({
          'payroll_records.user_id': req.user.id,
          'payroll_records.payroll_month': payrollMonth,
          'payroll_records.payroll_year': payrollYear,
        });

        if (!record) {
          return res.status(404).json({ message: 'Payroll record not found' });
        }
        payrollRecord = record;
      }

      // Get salary components
      // Filter out empty strings and invalid UUIDs to prevent SQL errors
      const componentIds = Object.keys(payrollRecord.component_breakdown || {}).filter(
        (id) => id && id.trim() !== '',
      );
      let components: Array<{ component: SalaryComponent; amount: number }> = [];

      if (componentIds.length > 0) {
        const salaryComponents = await SalaryComponent.query().whereIn('id', componentIds);
        components = salaryComponents.map((comp) => ({
          component: comp,
          amount: payrollRecord.component_breakdown[comp.id] || 0,
        }));
      }

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
      const currentUser = await User.query()
        .findById(req.user.id)
        .withGraphJoined('[department.location]');
      const payslipUser = (currentUser as User) || req.user;
      const payrollDetail = await UserPayrollDetail.query().findOne({ user_id: payslipUser.id });
      const bankDetail = await BankDetail.query().findOne({ user_id: payslipUser.id });
      const department = payslipUser.department_id
        ? await Department.query().findById(payslipUser.department_id)
        : null;

      departmentName = (currentUser as any)?.department?.name || department?.name;
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
        (currentUser as any)?.department?.location?.name ||
        (currentUser as any)?.department?.location?.address;
      if (!locationName && department?.location_id) {
        const { OfficeLocation } = await import('../../models/OfficeLocation');
        const deptLocation = await OfficeLocation.query().findById(department.location_id);
        locationName = deptLocation?.name || deptLocation?.address;
      }
      if (!departmentName && req.user.org_id) {
        const orgDepartment = await Department.query()
          .withGraphJoined('location')
          .where('departments.org_id', req.user.org_id)
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

      const payslipMetricsMy = await computePayslipAttendanceMetrics({
        orgId: req.user.org_id as string,
        userId: payslipUser.id,
        payrollMonth: Number(payrollRecord.payroll_month || 1),
        payrollYear: Number(payrollRecord.payroll_year || new Date().getFullYear()),
      });
      standardDays = payslipMetricsMy.standardDays;
      workingDays = payslipMetricsMy.workingDays;
      lopDays = payslipMetricsMy.lopDays;

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

  /**
   * Get monthly salary summary
   */
  static async getMonthlySummary(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = payrollMonthYearQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { month, year } = parsed.data;
    const currentDate = new Date();
    const payrollMonth = month ?? currentDate.getMonth() + 1;
    const payrollYear = year ?? currentDate.getFullYear();

    try {
      const payrollRecord = await PayrollRecord.query().withGraphJoined('user').findOne({
        'payroll_records.user_id': req.user.id,
        'payroll_records.payroll_month': payrollMonth,
        'payroll_records.payroll_year': payrollYear,
      });

      if (!payrollRecord) {
        return res.status(404).json({ message: 'Payroll record not found' });
      }

      const display = await resolvePayrollListDisplayAmounts(
        payrollRecordToPayslipPayPeriodInput(payrollRecord as any, req.user.org_id, req.user.id),
      );

      return res.json({
        month: payrollRecord.payroll_month,
        year: payrollRecord.payroll_year,
        gross_salary: payrollRecord.gross_salary,
        total_earnings: payrollRecord.total_earnings,
        total_deductions: payrollRecord.total_deductions,
        net_salary: display.net_salary,
        total: display.total,
        incentives: display.incentives,
        deductions: display.deductions,
        pf_contribution: payrollRecord.pf_contribution,
        professional_tax: payrollRecord.professional_tax,
        overtime_amount: payrollRecord.overtime_amount,
        incentive_amount: payrollRecord.incentive_amount,
        bonus_amount: payrollRecord.bonus_amount,
        allowance_amount: payrollRecord.allowance_amount,
        status: payrollRecord.status,
        payslip_pdf_url: payrollRecord.payslip_pdf_url,
      });
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to fetch monthly summary',
      });
    }
  }

  /**
   * Get yearly salary summary
   */
  static async getYearlySummary(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = payrollMonthYearQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { year } = parsed.data;
    const currentDate = new Date();
    const payrollYear = year ?? currentDate.getFullYear();

    try {
      const payrollRecords = await PayrollRecord.query()
        .where({ user_id: req.user.id, payroll_year: payrollYear })
        .whereIn('status', ['PROCESSED', 'PAID'])
        .orderBy('payroll_month', 'asc');

      const monthlyData = payrollRecords.map((record) => ({
        month: record.payroll_month,
        gross_salary: record.gross_salary,
        total_earnings: record.total_earnings,
        total_deductions: record.total_deductions,
        net_salary: record.net_salary,
        status: record.status,
      }));

      const totals = payrollRecords.reduce(
        (acc, record) => ({
          total_gross: acc.total_gross + Number(record.gross_salary),
          total_earnings: acc.total_earnings + Number(record.total_earnings),
          total_deductions: acc.total_deductions + Number(record.total_deductions),
          total_net: acc.total_net + Number(record.net_salary),
        }),
        { total_gross: 0, total_earnings: 0, total_deductions: 0, total_net: 0 },
      );

      return res.json({
        year: payrollYear,
        monthly_breakdown: monthlyData,
        totals,
      });
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to fetch yearly summary',
      });
    }
  }

  /**
   * Get tax summary
   */
  static async getTaxSummary(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = payrollMonthYearQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { year } = parsed.data;
    const currentDate = new Date();
    const payrollYear = year ?? currentDate.getFullYear();

    try {
      const payrollRecords = await PayrollRecord.query()
        .where({ user_id: req.user.id, payroll_year: payrollYear })
        .whereIn('status', ['PROCESSED', 'PAID']);

      const taxSummary = payrollRecords.reduce(
        (acc, record) => ({
          total_professional_tax: acc.total_professional_tax + Number(record.professional_tax || 0),
          total_taxable_income: acc.total_taxable_income + Number(record.gross_salary),
        }),
        { total_professional_tax: 0, total_taxable_income: 0 },
      );

      const payrollDetail = await UserPayrollDetail.query().findOne({ user_id: req.user.id });

      return res.json({
        year: payrollYear,
        total_taxable_income: taxSummary.total_taxable_income,
        total_professional_tax: taxSummary.total_professional_tax,
        total_tax: taxSummary.total_professional_tax,
        declared_tax: payrollDetail?.declared_tax,
        tax_saving_investments: payrollDetail?.tax_saving_investments,
        monthly_breakdown: payrollRecords.map((record) => ({
          month: record.payroll_month,
          taxable_income: record.gross_salary,
          professional_tax: record.professional_tax,
        })),
      });
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to fetch tax summary',
      });
    }
  }

  /**
   * Get employee "My Pay" dashboard data
   * Returns summary cards (worked days, overtime, unpaid), current month payroll, and payslip history
   */
  static async getMyPay(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = myPayQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const currentDate = new Date();
    const month = parsed.data.month ?? currentDate.getMonth() + 1;
    const year = parsed.data.year ?? currentDate.getFullYear();

    try {
      const userId = req.user.id;
      const org_id = req.user.org_id;

      // Calculate date range for the month
      const firstDay = new Date(year, month - 1, 1);
      const lastDay = new Date(year, month, 0);
      const startDate = firstDay.toISOString().split('T')[0];
      const endDate = lastDay.toISOString().split('T')[0];

      // Get attendance logs for the month
      const attendanceLogs = await AttendanceLog.query()
        .where('user_id', userId)
        .where('org_id', org_id)
        .whereBetween('date', [startDate, endDate])
        .whereNotNull('clock_in_time')
        .whereNotNull('clock_out_time');

      // Get leave requests for the month
      const leaveRequests = await LeaveRequest.query()
        .where('org_id', org_id)
        .where('user_id', userId)
        .whereIn('status', ['APPROVED', 'PENDING'])
        .where((qb) => {
          qb.whereBetween('start_date', [startDate, endDate])
            .orWhereBetween('end_date', [startDate, endDate])
            .orWhere((subQb) => {
              subQb.where('start_date', '<=', startDate).where('end_date', '>=', endDate);
            });
        });

      // Calculate worked days (days with both clock in and clock out)
      const workedDays = attendanceLogs.length;

      // Calculate total working days in month (excluding weekends)
      const totalDaysInMonth = lastDay.getDate();
      let totalWorkingDays = 0;
      for (let day = 1; day <= totalDaysInMonth; day++) {
        const date = new Date(year, month - 1, day);
        const dayOfWeek = date.getDay();
        // Count weekdays (Monday=1 to Friday=5)
        if (dayOfWeek >= 1 && dayOfWeek <= 5) {
          totalWorkingDays++;
        }
      }

      // Calculate overtime days (days with work hours > 8 hours)
      // Note: We'll calculate based on work duration, as overtime_seconds might not be in the model
      let overtimeDays = 0;
      for (const log of attendanceLogs) {
        if (log.clock_in_time && log.clock_out_time) {
          const clockIn = new Date(log.clock_in_time);
          const clockOut = new Date(log.clock_out_time);
          const workHours = (clockOut.getTime() - clockIn.getTime()) / (1000 * 60 * 60);
          // Consider overtime if work hours > 8
          if (workHours > 8) {
            overtimeDays++;
          }
        }
      }

      // Calculate unpaid days (absent days that are not on leave)
      const leaveDates = new Set<string>();
      for (const leave of leaveRequests) {
        const start = new Date(leave.start_date);
        const end = new Date(leave.end_date);
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          const dateStr = d.toISOString().split('T')[0];
          const dayOfWeek = d.getDay();
          // Only count weekdays
          if (dayOfWeek >= 1 && dayOfWeek <= 5) {
            leaveDates.add(dateStr);
          }
        }
      }

      const attendanceDates = new Set(
        attendanceLogs.map((log) => new Date(log.date).toISOString().split('T')[0]),
      );

      let unpaidDays = 0;
      for (let day = 1; day <= totalDaysInMonth; day++) {
        const date = new Date(year, month - 1, day);
        const dayOfWeek = date.getDay();
        if (dayOfWeek >= 1 && dayOfWeek <= 5) {
          const dateStr = date.toISOString().split('T')[0];
          if (!attendanceDates.has(dateStr) && !leaveDates.has(dateStr)) {
            unpaidDays++;
          }
        }
      }

      // Get current month payroll record
      const payrollRecord = await PayrollRecord.query()
        .where('user_id', userId)
        .where('org_id', org_id)
        .where('payroll_month', month)
        .where('payroll_year', year)
        .first();

      // Format month name
      const monthNames = [
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
      const monthName = monthNames[month - 1];

      // Get payslip history (last 10 records)
      const payslipHistory = await PayrollRecord.query()
        .where('user_id', userId)
        .where('org_id', org_id)
        .whereIn('status', ['PAID', 'ADJUSTED', 'PROCESSED'])
        .orderBy('payroll_year', 'desc')
        .orderBy('payroll_month', 'desc')
        .limit(10);

      const formatPayrollDate = (m: number, y: number): string => {
        const monthStr = String(m).padStart(2, '0');
        return `${y}-${monthStr}-01`;
      };

      const historyDisplayList = await resolvePayrollListDisplayAmountsBatch(
        payslipHistory.map((record) =>
          payrollRecordToPayslipPayPeriodInput(record as any, org_id, userId),
        ),
      );

      const currentMonthDisplay = payrollRecord
        ? await resolvePayrollListDisplayAmounts(
            payrollRecordToPayslipPayPeriodInput(payrollRecord as any, org_id, userId),
          )
        : null;

      return res.json({
        selected_range: {
          month,
          year,
          month_name: monthName,
          start_date: startDate,
          end_date: endDate,
        },
        summary_cards: {
          worked_days: {
            worked: workedDays,
            total: totalWorkingDays,
            label: `Worked ${workedDays} / ${totalWorkingDays} Days`,
          },
          overtime_days: {
            days: overtimeDays,
            label: `Overtime ${overtimeDays} Days`,
          },
          unpaid_days: {
            days: unpaidDays,
            label: `Unpaid ${unpaidDays} Days`,
          },
        },
        current_month:
          payrollRecord && currentMonthDisplay
            ? {
                id: payrollRecord.id,
                month,
                year,
                month_name: monthName,
                status: payrollRecord.status,
                net_salary: currentMonthDisplay.net_salary,
                gross_salary: Number(payrollRecord.gross_salary || 0),
                incentives: currentMonthDisplay.incentives,
                deductions: currentMonthDisplay.deductions,
                total: currentMonthDisplay.total,
                date: formatPayrollDate(month, year),
                paid_at: payrollRecord.paid_at,
                payslip_url: payrollRecord.payslip_pdf_url ?? null,
              }
            : null,
        payslip_history: payslipHistory.map((record, index) => {
          const display = historyDisplayList[index];
          return {
            id: record.id,
            month: record.payroll_month,
            year: record.payroll_year,
            month_name: monthNames[record.payroll_month - 1],
            status: record.status,
            net_salary: display.net_salary,
            total: display.total,
            incentives: display.incentives,
            deductions: display.deductions,
            date: formatPayrollDate(record.payroll_month, record.payroll_year),
            credited_date: record.paid_at
              ? new Date(record.paid_at).toISOString().split('T')[0]
              : null,
            payslip_url: record.payslip_pdf_url ?? null,
          };
        }),
      });
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to fetch pay data',
      });
    }
  }

  /**
   * Get employee payslip history (paginated)
   */
  static async getMyPayHistory(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = myPayHistoryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { page, limit } = parsed.data;

    try {
      const userId = req.user.id;
      const org_id = req.user.org_id;

      const offset = (page - 1) * limit;

      // Get total count
      const totalCount = await PayrollRecord.query()
        .where('user_id', userId)
        .where('org_id', org_id)
        .whereIn('status', ['PAID', 'ADJUSTED', 'PROCESSED'])
        .resultSize();

      // Get paginated records
      const payrollRecords = await PayrollRecord.query()
        .where('user_id', userId)
        .where('org_id', org_id)
        .whereIn('status', ['PAID', 'ADJUSTED', 'PROCESSED'])
        .orderBy('payroll_year', 'desc')
        .orderBy('payroll_month', 'desc')
        .limit(limit)
        .offset(offset);

      const monthNames = [
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

      const formatPayrollDate = (m: number, y: number): string => {
        const monthStr = String(m).padStart(2, '0');
        return `${y}-${monthStr}-01`;
      };

      const displayAmountsList = await resolvePayrollListDisplayAmountsBatch(
        payrollRecords.map((record) =>
          payrollRecordToPayslipPayPeriodInput(record as any, org_id, userId),
        ),
      );

      return res.json({
        items: payrollRecords.map((record, index) => {
          const display = displayAmountsList[index];
          return {
            id: record.id,
            month: record.payroll_month,
            year: record.payroll_year,
            month_name: monthNames[record.payroll_month - 1],
            status: record.status,
            net_salary: display.net_salary,
            total: display.total,
            incentives: display.incentives,
            deductions: display.deductions,
            date: formatPayrollDate(record.payroll_month, record.payroll_year),
            credited_date: record.paid_at
              ? new Date(record.paid_at).toISOString().split('T')[0]
              : null,
            payslip_url: record.payslip_pdf_url ?? null,
          };
        }),
        pagination: {
          page,
          limit,
          total: totalCount,
          total_pages: Math.ceil(totalCount / limit),
        },
      });
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to fetch payslip history',
      });
    }
  }
}
