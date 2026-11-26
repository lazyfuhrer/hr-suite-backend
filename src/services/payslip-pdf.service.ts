import PDFDocument from 'pdfkit';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'crypto';

import { getS3Client, buildS3PublicUrl } from '../utils/s3';
import { env } from '../config/env';
import { PayrollRecord } from '../models/PayrollRecord';
import { SalaryComponent } from '../models/SalaryComponent';
import { computePayslipAttendanceMetrics } from '../utils/payslip-attendance-metrics.utils';
import {
  computeOtherEarningsEarnedForPeriod,
  computePayslipPayPeriodTotals,
} from '../utils/payslip-pay-period-totals.utils';
import type { User } from '../models/User';
import type { SalaryComponent as SalaryComponentType } from '../models/SalaryComponent';

interface PayslipData {
  payrollRecord: PayrollRecord;
  user: User;
  components: Array<{ component: SalaryComponentType; amount: number }>;
  organizationName?: string;
  organizationLogoUrl?: string;
  organizationEmail?: string;
  organizationAddress?: string;
  organizationPhone?: string;
  departmentName?: string;
  locationName?: string;
  panNumber?: string;
  uanNumber?: string;
  pfNumber?: string;
  bankAccount?: string;
  standardDays?: number;
  workingDays?: number;
  lopDays?: number;
}

/**
 * Convert number to words (Indian numbering system)
 */
function numberToWords(num: number): string {
  const ones = [
    '',
    'One',
    'Two',
    'Three',
    'Four',
    'Five',
    'Six',
    'Seven',
    'Eight',
    'Nine',
    'Ten',
    'Eleven',
    'Twelve',
    'Thirteen',
    'Fourteen',
    'Fifteen',
    'Sixteen',
    'Seventeen',
    'Eighteen',
    'Nineteen',
  ];
  const tens = [
    '',
    '',
    'Twenty',
    'Thirty',
    'Forty',
    'Fifty',
    'Sixty',
    'Seventy',
    'Eighty',
    'Ninety',
  ];

  if (num === 0) return 'Zero';

  function convertHundreds(n: number): string {
    let result = '';
    if (n >= 100) {
      result += ones[Math.floor(n / 100)] + ' Hundred ';
      n %= 100;
    }
    if (n >= 20) {
      result += tens[Math.floor(n / 10)] + ' ';
      n %= 10;
    }
    if (n > 0) {
      result += ones[n] + ' ';
    }
    return result.trim();
  }

  if (num >= 10000000) {
    const crores = Math.floor(num / 10000000);
    const remainder = num % 10000000;
    const crorePart = `${convertHundreds(crores)} Crore`;
    const lakhPart =
      remainder > 0 ? `${convertHundreds(Math.floor(remainder / 100000))} Lakh`.trim() : '';
    const remPart = remainder % 100000 > 0 ? convertHundreds(remainder % 100000) : '';
    return [crorePart, lakhPart, remPart].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  } else if (num >= 100000) {
    const lakhs = Math.floor(num / 100000);
    const remainder = num % 100000;
    return [`${convertHundreds(lakhs)} Lakh`, remainder > 0 ? convertHundreds(remainder) : '']
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  } else if (num >= 1000) {
    const thousands = Math.floor(num / 1000);
    const remainder = num % 1000;
    return [
      `${convertHundreds(thousands)} Thousand`,
      remainder > 0 ? convertHundreds(remainder) : '',
    ]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  } else {
    return convertHundreds(num);
  }
}

/**
 * Format number with Indian number system (commas)
 * Example: 12345678.9 -> 1,23,45,678.90
 */
function formatIndianNumber(num: number, fractionDigits = 2): string {
  const fixed = num.toFixed(fractionDigits);
  const [integerPartRaw, decimalPartRaw] = fixed.split('.');
  const integerPart = integerPartRaw.replace(/[^0-9-]/g, '');

  const isNegative = integerPart.startsWith('-');
  const unsignedInt = isNegative ? integerPart.slice(1) : integerPart;

  if (unsignedInt.length <= 3) {
    const base = unsignedInt;
    const withSign = isNegative ? `-${base}` : base;
    if (!decimalPartRaw || Number(decimalPartRaw) === 0) return withSign;
    return `${withSign}.${decimalPartRaw}`;
  }

  const lastThree = unsignedInt.slice(-3);
  const other = unsignedInt.slice(0, -3);
  const groupedOther = other.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const combined = `${groupedOther},${lastThree}`;
  const withSign = isNegative ? `-${combined}` : combined;

  if (!decimalPartRaw || Number(decimalPartRaw) === 0) return withSign;
  return `${withSign}.${decimalPartRaw}`;
}

const EARNING_TYPES_FOR_SLIP = new Set(['EARNING', 'ALLOWANCE', 'BONUS', 'OVERTIME', 'INCENTIVE']);
const PAYROLL_YTD_STATUSES = ['PAID', 'PROCESSED', 'ADJUSTED'] as const;

/** LOP payFactor applies to these earning row sources (structure + residual gap), not variable pay or payroll adjustments. */
type EarningRowSourceForLop =
  | 'component'
  | 'gross_basic'
  | 'other'
  | 'overtime'
  | 'incentive'
  | 'bonus'
  | 'allowance'
  | 'adjustment_incentive';

function isLopProratedEarningSource(source: EarningRowSourceForLop): boolean {
  return source === 'component' || source === 'gross_basic' || source === 'other';
}

function normalizeEarningLabel(s: string): string {
  return s.trim().toLowerCase();
}

/** Payslip display label: drop trailing "(HRA)" from House Rent Allowance. */
function formatPayslipEarningLabel(label: string): string {
  return String(label || '')
    .replace(/\s*\(HRA\)\s*$/i, '')
    .trim();
}

/** First month (April) of the Indian financial year that contains `payrollMonth` / `payrollYear`. */
function indianFYStart(payrollMonth: number, payrollYear: number): { m: number; y: number } {
  if (payrollMonth >= 4) return { m: 4, y: payrollYear };
  return { m: 4, y: payrollYear - 1 };
}

function compareCalendarMonth(a: { m: number; y: number }, b: { m: number; y: number }): number {
  if (a.y !== b.y) return a.y - b.y;
  return a.m - b.m;
}

function monthBeforePayroll(payrollMonth: number, payrollYear: number): { m: number; y: number } {
  if (payrollMonth === 1) return { m: 12, y: payrollYear - 1 };
  return { m: payrollMonth - 1, y: payrollYear };
}

type ComponentLite = { id: string; type: string; name: string };

function hasBasicSalaryInBreakdown(
  breakdown: Record<string, number>,
  byId: Map<string, ComponentLite>,
): boolean {
  for (const id of Object.keys(breakdown || {})) {
    const c = byId.get(id);
    if (!c || !EARNING_TYPES_FOR_SLIP.has(c.type)) continue;
    if (normalizeEarningLabel(c.name) === 'basic salary') return true;
  }
  return false;
}

/**
 * Sums earnings attributed to prior months in the same Indian FY (excludes the payslip month).
 * Used for per-line YTD on the PDF.
 */
async function aggregateIndianFyPriorEarnings(
  orgId: string,
  userId: string,
  payrollMonth: number,
  payrollYear: number,
): Promise<{
  byComponentId: Map<string, number>;
  grossBasicSum: number;
  overtime: number;
  incentive: number;
  bonus: number;
  allowance: number;
  /** Cumulative prior-month "Other Earnings" earned (matches payslip structural gap × LOP). */
  otherEarningsEarnedSum: number;
  adjustmentIncentivesByKey: Map<string, number>;
}> {
  const result = {
    byComponentId: new Map<string, number>(),
    grossBasicSum: 0,
    overtime: 0,
    incentive: 0,
    bonus: 0,
    allowance: 0,
    otherEarningsEarnedSum: 0,
    adjustmentIncentivesByKey: new Map<string, number>(),
  };

  const fyStart = indianFYStart(payrollMonth, payrollYear);
  const fyEnd = monthBeforePayroll(payrollMonth, payrollYear);
  if (compareCalendarMonth(fyEnd, fyStart) < 0) return result;

  const allOrgComponents = await SalaryComponent.query()
    .where({ org_id: orgId })
    .select('id', 'type', 'name');
  const byId = new Map<string, ComponentLite>(
    allOrgComponents.map((c) => [c.id, { id: c.id, type: c.type, name: c.name }]),
  );

  const priorRecords = await PayrollRecord.query()
    .where({ org_id: orgId, user_id: userId })
    .whereIn('status', [...PAYROLL_YTD_STATUSES])
    .whereRaw('make_date(payroll_year, payroll_month, 1) >= make_date(?, ?, 1)', [
      fyStart.y,
      fyStart.m,
    ])
    .whereRaw('make_date(payroll_year, payroll_month, 1) <= make_date(?, ?, 1)', [fyEnd.y, fyEnd.m])
    .orderBy('payroll_year')
    .orderBy('payroll_month')
    .orderBy('updated_at', 'desc');

  const seenPeriod = new Set<string>();
  for (const rec of priorRecords) {
    const periodKey = `${rec.payroll_year}-${rec.payroll_month}`;
    if (seenPeriod.has(periodKey)) continue;
    seenPeriod.add(periodKey);

    const m = Number(rec.payroll_month);
    const y = Number(rec.payroll_year);

    const bd = (rec.component_breakdown || {}) as Record<string, number>;
    const hasBasic = hasBasicSalaryInBreakdown(bd, byId);

    const SALARY_MONTH_DAYS = 30;
    let lopPayFactor = 1;
    try {
      const att = await computePayslipAttendanceMetrics({
        orgId,
        userId,
        payrollMonth: m,
        payrollYear: y,
      });
      const lop = Math.min(Math.max(0, att.lopDays), SALARY_MONTH_DAYS);
      lopPayFactor = (SALARY_MONTH_DAYS - lop) / SALARY_MONTH_DAYS;
    } catch {
      lopPayFactor = 1;
    }

    for (const [idStr, rawAmt] of Object.entries(bd)) {
      const c = byId.get(idStr);
      if (!c || !EARNING_TYPES_FOR_SLIP.has(c.type)) continue;
      const amt = Number((Number(rawAmt || 0) * lopPayFactor).toFixed(2));
      result.byComponentId.set(idStr, (result.byComponentId.get(idStr) || 0) + amt);
    }

    if (!hasBasic && Number(rec.gross_salary || 0) > 0) {
      result.grossBasicSum += Number((Number(rec.gross_salary || 0) * lopPayFactor).toFixed(2));
    }

    const priorAdjInc = Array.isArray((rec as any).adjustment_incentives)
      ? ((rec as any).adjustment_incentives as Array<{ name: string; amount: number }>)
      : [];
    const useColumnVariablePay = priorAdjInc.length === 0;

    if (useColumnVariablePay) {
      result.overtime += Number(rec.overtime_amount || 0);
      result.incentive += Number(rec.incentive_amount || 0);
      result.bonus += Number(rec.bonus_amount || 0);
      result.allowance += Number(rec.allowance_amount || 0);
    } else {
      result.allowance += Number(rec.allowance_amount || 0);
    }

    for (const inc of priorAdjInc) {
      const rawName = String((inc as any)?.name || '').trim();
      const amt = Number((inc as any)?.amount || 0);
      if (!rawName || !Number.isFinite(amt) || amt === 0) continue;
      const key = normalizeEarningLabel(rawName);
      result.adjustmentIncentivesByKey.set(
        key,
        (result.adjustmentIncentivesByKey.get(key) || 0) + amt,
      );
    }

    const adjustmentExtraForPrior = Array.isArray((rec as any).adjustment_extra_deductions)
      ? (((rec as any).adjustment_extra_deductions as Array<{
          name: string;
          amount: number;
        }>) ?? [])
      : [];

    const monthOtherEarned = await computeOtherEarningsEarnedForPeriod({
      orgId,
      userId,
      payrollMonth: m,
      payrollYear: y,
      gross_salary: Number(rec.gross_salary || 0),
      total_earnings: Number(rec.total_earnings || 0),
      total_deductions: Number(rec.total_deductions || 0),
      pf_contribution: rec.pf_contribution,
      professional_tax: rec.professional_tax,
      overtime_amount: rec.overtime_amount,
      incentive_amount: rec.incentive_amount,
      bonus_amount: rec.bonus_amount,
      allowance_amount: rec.allowance_amount,
      component_breakdown: bd,
      adjustment_incentives: priorAdjInc,
      adjustment_extra_deductions: adjustmentExtraForPrior,
    });
    result.otherEarningsEarnedSum += monthOtherEarned;
  }

  return result;
}

export class PayslipPdfService {
  /**
   * Generate a PDF payslip and upload it to S3
   */
  static async generateAndUploadPayslip(data: PayslipData): Promise<string> {
    const { payrollRecord } = data;
    const pdfBuffer = await this.generatePayslipBuffer(data);

    // Upload to S3
    const key = [
      'orgs',
      payrollRecord.org_id,
      'users',
      payrollRecord.user_id,
      'payslips',
      `${payrollRecord.payroll_year}-${String(payrollRecord.payroll_month).padStart(2, '0')}`,
      `payslip-${crypto.randomUUID()}.pdf`,
    ].join('/');

    try {
      const command = new PutObjectCommand({
        Bucket: env.S3_BUCKET!,
        Key: key,
        ContentType: 'application/pdf',
        Body: pdfBuffer,
      });

      await getS3Client().send(command);
      return buildS3PublicUrl(key);
    } catch (error) {
      throw new Error(
        `Failed to upload payslip to S3: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Generate PDF buffer (for direct download without S3)
   */
  static async generatePayslipBuffer(data: PayslipData): Promise<Buffer> {
    const {
      payrollRecord,
      user,
      components,
      organizationName,
      organizationLogoUrl,
      organizationEmail,
      organizationAddress,
      organizationPhone,
      departmentName,
      locationName,
      panNumber,
      uanNumber,
      pfNumber,
      bankAccount,
      standardDays,
      workingDays,
      lopDays,
    } = data;

    const doc = new PDFDocument({ size: 'A4', margin: 24 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    let organizationLogoBuffer: Buffer | undefined;

    if (organizationLogoUrl) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        const response = await fetch(organizationLogoUrl, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          organizationLogoBuffer = Buffer.from(arrayBuffer);
        }
      } catch {
        // Ignore logo load failures and fall back to default placeholder
        organizationLogoBuffer = undefined;
      }
    }

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

    const month = Number(payrollRecord.payroll_month || 1);
    const monthIndex = Math.min(11, Math.max(0, month - 1));
    const monthName = monthNames[monthIndex];
    const year = Number(payrollRecord.payroll_year || new Date().getFullYear());
    const employeeName = `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Employee';

    const currency = (value: number): string => {
      const amount = Number(value);
      if (!Number.isFinite(amount)) {
        return '0.00';
      }
      const fractionDigits = Number.isInteger(amount) ? 0 : 2;
      return formatIndianNumber(amount, fractionDigits);
    };
    const formatShortDate = (value?: string): string => {
      if (!value) return 'N/A';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      const day = String(date.getDate()).padStart(2, '0');
      const month = date.toLocaleString('en-IN', { month: 'short' });
      const yearStr = String(date.getFullYear());
      return `${day}-${month}-${yearStr}`;
    };
    const monthLabel = `${monthName.toUpperCase()} ${year}`;
    const initial = (organizationName || 'S').trim().charAt(0).toUpperCase() || 'S';
    const totalDaysInMonth = new Date(year, month, 0).getDate();
    const stdDays = Number.isFinite(Number(standardDays))
      ? Number(standardDays)
      : Number(totalDaysInMonth);
    const workedDays = Number.isFinite(Number(workingDays)) ? Number(workingDays) : Number(stdDays);
    const lossOfPayDays = Number.isFinite(Number(lopDays))
      ? Number(lopDays)
      : Math.max(0, stdDays - workedDays);

    const drawCard = (x: number, y: number, w: number, h: number, fill: string, stroke: string) => {
      doc.save();
      doc.roundedRect(x, y, w, h, 8).fillAndStroke(fill, stroke);
      doc.restore();
    };

    const drawCellValue = (
      text: string,
      x: number,
      y: number,
      width: number,
      align: 'left' | 'right',
    ) => {
      doc.text(text, x + 8, y + 8, { width: width - 16, align, lineBreak: false, ellipsis: true });
    };

    // Top accent bar
    doc.save();
    doc.rect(0, 0, doc.page.width, 6).fill('#F97316');
    doc.restore();

    const left = 28;
    const pageWidth = doc.page.width - left * 2;

    // Header (letterhead) layout based on design specs
    const headerPaddingTop = 16;
    const headerY = doc.page.margins.top + headerPaddingTop;

    // Left: logo + company info
    const logoSize = 48;
    const logoRadius = 8;
    const headerGap = 16;
    const leftGroupDesignWidth = 329.8399963378906;
    const totalDesignWidth = 680.315185546875;
    const leftGroupWidth = (leftGroupDesignWidth / totalDesignWidth) * pageWidth;

    if (organizationLogoBuffer) {
      try {
        // Draw outline of the logo box to preserve shape, no orange fill behind logo
        doc
          .roundedRect(left, headerY, logoSize, logoSize, logoRadius)
          .lineWidth(1)
          .stroke('#F97316');

        // Draw logo image at a fixed inner size, centered in the box
        const innerSize = 32;
        const inset = (logoSize - innerSize) / 2;
        const logoX = left + inset;
        const logoY = headerY + inset;

        doc.image(organizationLogoBuffer, logoX, logoY, {
          fit: [innerSize, innerSize],
        });
      } catch {
        // If anything goes wrong, fall back to the initial letter
        doc.roundedRect(left, headerY, logoSize, logoSize, logoRadius).fill('#F97316');
        doc
          .font('Helvetica-Bold')
          .fontSize(18)
          .fillColor('#FFFFFF')
          .text(initial, left, headerY + 12, { width: logoSize, align: 'center' });
      }
    } else {
      // No logo available – show initial as before
      doc.roundedRect(left, headerY, logoSize, logoSize, logoRadius).fill('#F97316');
      doc
        .font('Helvetica-Bold')
        .fontSize(18)
        .fillColor('#FFFFFF')
        .text(initial, left, headerY + 12, { width: logoSize, align: 'center' });
    }

    const companyTextX = left + logoSize + headerGap;
    const companyTextWidth = leftGroupWidth - logoSize - headerGap;
    doc
      .font('Helvetica-Bold')
      .fontSize(14)
      .fillColor('#111827')
      .text(organizationName || 'Organization', companyTextX, headerY + 4, {
        width: companyTextWidth,
        lineBreak: false,
        ellipsis: true,
      });
    doc.font('Helvetica').fontSize(8).fillColor('#6B7280');
    const addressY = headerY + 24;
    const maxAddressBlockHeight = 18; // cap to ~2 lines
    const rowGap = 1;

    // Address can wrap; measure actual height (capped) so we don't add extra blank space.
    let addressHeight = 0;
    if (organizationAddress) {
      doc.font('Helvetica').fontSize(7.5).fillColor('#6B7280');
      const measured = doc.heightOfString(organizationAddress, {
        width: companyTextWidth,
        lineGap: 1,
      });
      addressHeight = Math.min(maxAddressBlockHeight, measured);
      doc.text(organizationAddress, companyTextX, addressY, {
        width: companyTextWidth,
        height: maxAddressBlockHeight,
        ellipsis: true,
        lineGap: 1,
      });
    }

    let metaY = addressY + addressHeight + rowGap;
    doc.font('Helvetica').fontSize(8).fillColor('#6B7280');
    if (organizationEmail) {
      doc.text(`Email: ${organizationEmail}`, companyTextX, metaY, {
        width: companyTextWidth,
        lineBreak: false,
        ellipsis: true,
      });
      metaY += 9;
    }
    if (organizationPhone) {
      doc.text(`Phone: ${organizationPhone}`, companyTextX, metaY, {
        width: companyTextWidth,
        lineBreak: false,
        ellipsis: true,
      });
    }

    // Right: PAYSLIP badge + period
    const rightGroupDesignWidth = 118.16999816894531;
    const rightGroupWidth = (rightGroupDesignWidth / totalDesignWidth) * pageWidth;
    const rightGroupX = left + pageWidth - rightGroupWidth;
    const badgeDesignWidth = 63.77000045776367;
    const badgeDesignHeight = 21;
    const badgeWidth = badgeDesignWidth;
    const badgeHeight = badgeDesignHeight;
    const badgeX = rightGroupX + rightGroupWidth - badgeWidth;
    const badgeY = headerY;

    // PAYSLIP pill (border-radius: 9999px, padding 4px 12px)
    doc.save();
    doc
      .roundedRect(badgeX, badgeY, badgeWidth, badgeHeight, 9999)
      .fillAndStroke('#E2E8F0', '#CBD5E1');
    doc.restore();
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor('#475569')
      .text('PAYSLIP', badgeX, badgeY + 4, {
        width: badgeWidth,
        align: 'center',
        lineBreak: false,
        ellipsis: true,
      });

    const periodY = badgeY + badgeHeight + 8;
    doc.font('Helvetica-Bold').fontSize(26).fillColor('#EA580C');
    const periodTextWidth = doc.widthOfString(monthLabel);
    const periodX = rightGroupX + rightGroupWidth - periodTextWidth;
    doc.text(monthLabel, periodX, periodY, {
      lineBreak: false,
    });

    let y = 112;
    const infoHeight = 176;
    drawCard(left, y, pageWidth, infoHeight, '#F8FAFC', '#D8E0EB');

    const cols = 4;
    const colWidth = pageWidth / cols;
    const rowHeight = 36;
    const infoRows = [
      [
        { label: 'EMPLOYEE ID', value: user.employee_id || 'N/A' },
        { label: 'EMPLOYEE NAME', value: employeeName },
        { label: 'GRADE', value: 'N/A' },
        { label: 'DESIGNATION', value: user.designation || 'N/A' },
      ],
      [
        { label: 'DEPARTMENT', value: departmentName || 'N/A' },
        { label: 'LOCATION', value: locationName || organizationAddress?.split(',')[0] || 'N/A' },
        { label: 'DATE OF JOINING', value: formatShortDate(user.date_of_joining) },
        { label: 'PAN', value: panNumber || 'N/A' },
      ],
      [
        { label: 'UAN', value: uanNumber || 'N/A' },
        { label: 'PF NUMBER', value: pfNumber || 'N/A' },
        { label: 'BANK ACCOUNT', value: bankAccount || 'N/A' },
        { label: '', value: '' },
      ],
      [
        { label: 'STANDARD DAYS', value: String(stdDays) },
        { label: 'WORKING DAYS', value: String(workedDays) },
        { label: 'LOP DAYS', value: String(lossOfPayDays) },
        { label: '', value: '' },
      ],
    ];

    for (let r = 0; r < infoRows.length; r += 1) {
      const rowY = y + 8 + r * rowHeight;
      if (r > 0) {
        doc
          .strokeColor('#D8E0EB')
          .lineWidth(0.5)
          .moveTo(left + 12, rowY - 4)
          .lineTo(left + pageWidth - 12, rowY - 4)
          .stroke();
      }
      for (let c = 0; c < cols; c += 1) {
        const cell = infoRows[r][c];
        const x = left + c * colWidth + 12;
        if (!cell.label) {
          continue;
        }

        doc.font('Helvetica').fontSize(9).fillColor('#64748B').text(cell.label, x, rowY);

        // Ensure BANK ACCOUNT value stays on a single line
        if (cell.label === 'BANK ACCOUNT') {
          doc
            .font('Helvetica-Bold')
            .fontSize(10)
            .fillColor('#111827')
            .text(cell.value, x, rowY + 14, {
              lineBreak: false,
            });
        } else {
          doc
            .font('Helvetica-Bold')
            .fontSize(10)
            .fillColor('#111827')
            .text(cell.value, x, rowY + 14, {
              width: colWidth - 20,
              lineBreak: false,
              ellipsis: true,
            });
        }
      }
    }

    type EarningRowSource =
      | 'component'
      | 'gross_basic'
      | 'overtime'
      | 'incentive'
      | 'bonus'
      | 'allowance'
      | 'other'
      | 'adjustment_incentive';

    type EarningRow = {
      label: string;
      /** Annual figure for ACTUAL column (full contractual monthly × 12; unchanged by LOP). */
      actual: number;
      /** This month's earnings after LOP (structure lines × payFactor; variable/adjustment at full). */
      earned: number;
      ytd: number;
      componentId?: string;
      source: EarningRowSource;
    };

    const earningTypes = ['EARNING', 'ALLOWANCE', 'BONUS', 'OVERTIME', 'INCENTIVE'];
    const earningRows: EarningRow[] = [];
    const hasEarningLabel = new Set<string>();
    let earningComponentTotal = 0;

    const pushEarning = (
      label: string,
      monthlyAmount: number,
      source: EarningRowSource,
      componentId?: string,
    ) => {
      const normalized = normalizeEarningLabel(label);
      if (!normalized || hasEarningLabel.has(normalized)) return;
      const monthly = Number(monthlyAmount || 0);
      hasEarningLabel.add(normalized);
      const annual = Number((monthly * 12).toFixed(2));
      earningRows.push({
        label,
        actual: annual,
        earned: monthly,
        ytd: 0,
        componentId,
        source,
      });
      earningComponentTotal += monthly;
    };

    const earningComponents = components
      .filter((c) => earningTypes.includes(c.component.type))
      .sort((a, b) => (a.component.display_order || 0) - (b.component.display_order || 0));

    earningComponents.forEach(({ component, amount }) => {
      pushEarning(
        formatPayslipEarningLabel(component.name),
        Number(amount || 0),
        'component',
        component.id,
      );
    });

    if (!hasEarningLabel.has('basic salary') && Number(payrollRecord.gross_salary || 0) > 0) {
      pushEarning('Basic Salary', Number(payrollRecord.gross_salary || 0), 'gross_basic');
    }

    const adjustmentIncentives: Array<{ name: string; amount: number }> = Array.isArray(
      (payrollRecord as any).adjustment_incentives,
    )
      ? (((payrollRecord as any).adjustment_incentives as Array<{
          name: string;
          amount: number;
        }>) ?? [])
      : [];
    const adjustmentIncentiveSum = adjustmentIncentives.reduce(
      (sum, inc) => sum + Number((inc as any)?.amount || 0),
      0,
    );
    const useColumnVariablePay = adjustmentIncentives.length === 0;

    const specialEarnings: Array<[string, number, EarningRowSource]> = useColumnVariablePay
      ? [
          ['Overtime', Number(payrollRecord.overtime_amount || 0), 'overtime'],
          ['Incentive', Number(payrollRecord.incentive_amount || 0), 'incentive'],
          ['Bonus', Number(payrollRecord.bonus_amount || 0), 'bonus'],
          ['Allowance', Number(payrollRecord.allowance_amount || 0), 'allowance'],
        ]
      : [['Allowance', Number(payrollRecord.allowance_amount || 0), 'allowance']];
    specialEarnings.forEach(([label, amount, src]) => {
      if (amount > 0) pushEarning(label, amount, src);
    });
    const adjustmentIncentiveByLabel = new Map<string, number>();
    for (const inc of adjustmentIncentives) {
      const name = String((inc as any)?.name || '').trim();
      const amt = Number((inc as any)?.amount || 0);
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

    // Structural gap only (total_earnings includes adjustment incentives once).
    const totalEarningsFromRecord = Number(payrollRecord.total_earnings || 0);
    const structuralEarningsTarget = Number(
      (totalEarningsFromRecord - adjustmentIncentiveSum).toFixed(2),
    );
    const otherResidual = Number((structuralEarningsTarget - earningComponentTotal).toFixed(2));
    pushEarning('Other Earnings', otherResidual, 'other');

    // LOP: prorate structure-backed earnings (components, gross_basic, residual "Other") so
    // net aligns with salary_per_month × payFactor; variable columns & adjustment incentives stay full.
    const SALARY_MONTH_DAYS = 30;
    const lopForSalary = Math.min(Math.max(0, lossOfPayDays), SALARY_MONTH_DAYS);
    const lopPayFactor = (SALARY_MONTH_DAYS - lopForSalary) / SALARY_MONTH_DAYS;
    if (lopForSalary > 0 && lopPayFactor < 1) {
      for (const row of earningRows) {
        if (!isLopProratedEarningSource(row.source as EarningRowSourceForLop)) continue;
        row.earned = Number((row.earned * lopPayFactor).toFixed(2));
      }
    }

    const adjustmentExtraForTotalsEarly = Array.isArray(
      (payrollRecord as any).adjustment_extra_deductions,
    )
      ? (((payrollRecord as any).adjustment_extra_deductions as Array<{
          name: string;
          amount: number;
        }>) ?? [])
      : [];

    const alignedPeriodTotals = await computePayslipPayPeriodTotals({
      orgId: payrollRecord.org_id,
      userId: payrollRecord.user_id,
      payrollMonth: month,
      payrollYear: year,
      gross_salary: Number(payrollRecord.gross_salary || 0),
      total_earnings: Number(payrollRecord.total_earnings || 0),
      total_deductions: Number(payrollRecord.total_deductions || 0),
      pf_contribution: payrollRecord.pf_contribution,
      professional_tax: payrollRecord.professional_tax,
      overtime_amount: payrollRecord.overtime_amount,
      incentive_amount: payrollRecord.incentive_amount,
      bonus_amount: payrollRecord.bonus_amount,
      allowance_amount: payrollRecord.allowance_amount,
      component_breakdown: (payrollRecord.component_breakdown || {}) as Record<string, number>,
      adjustment_incentives: adjustmentIncentives,
      adjustment_extra_deductions: adjustmentExtraForTotalsEarly,
    });

    const earningsTotalToShow = alignedPeriodTotals.earningsTotal;
    const deductionsTotalToShow = alignedPeriodTotals.deductionsTotal;
    const netSalary = alignedPeriodTotals.payslipNet;

    const reconcileEarningRowsToPeriodTotal = (rows: EarningRow[], targetTotal: number): void => {
      const sum = rows.reduce((s, row) => s + row.earned, 0);
      const delta = Number((targetTotal - sum).toFixed(2));
      if (Math.abs(delta) <= 0.01 || rows.length === 0) return;
      const otherIdx = rows.findIndex(
        (row) => normalizeEarningLabel(row.label) === 'other earnings',
      );
      const idx = otherIdx >= 0 ? otherIdx : rows.length - 1;
      rows[idx].earned = Number((rows[idx].earned + delta).toFixed(2));
    };

    reconcileEarningRowsToPeriodTotal(earningRows, earningsTotalToShow);

    const fyPrior = await aggregateIndianFyPriorEarnings(
      payrollRecord.org_id,
      payrollRecord.user_id,
      month,
      year,
    );

    const adjustmentRowsForYtd = earningRows.filter((r) => r.source === 'adjustment_incentive');
    const adjustmentRowCount = adjustmentRowsForYtd.length;
    const currentAdjLabels = new Set(
      adjustmentRowsForYtd.map((r) => normalizeEarningLabel(r.label)),
    );
    let matchedPriorForCurrentLabels = 0;
    for (const [key, amt] of fyPrior.adjustmentIncentivesByKey.entries()) {
      if (currentAdjLabels.has(key)) {
        matchedPriorForCurrentLabels += amt;
      }
    }
    const totalPriorAdjustment = [...fyPrior.adjustmentIncentivesByKey.values()].reduce(
      (sum, amt) => sum + amt,
      0,
    );
    // Prior keys from renamed adjustments (e.g. "wada") must roll into later rows even when
    // the current month reuses another key (e.g. "wfa").
    const orphanPriorAdjustment = Number(
      (totalPriorAdjustment - matchedPriorForCurrentLabels).toFixed(2),
    );
    let adjustmentRowIndex = 0;
    let orphanPriorDistributed = 0;
    const hasOtherEarningsRow = earningRows.some(
      (r) => normalizeEarningLabel(r.label) === 'other earnings',
    );

    for (const row of earningRows) {
      let prior = 0;
      if (row.componentId) {
        prior = fyPrior.byComponentId.get(row.componentId) || 0;
      } else if (row.source === 'gross_basic') {
        prior = fyPrior.grossBasicSum;
      } else if (row.source === 'overtime') {
        prior = fyPrior.overtime;
      } else if (row.source === 'incentive') {
        prior = fyPrior.incentive;
      } else if (row.source === 'bonus') {
        prior = fyPrior.bonus;
      } else if (row.source === 'allowance') {
        prior = fyPrior.allowance;
      } else if (row.source === 'other' || normalizeEarningLabel(row.label) === 'other earnings') {
        prior = fyPrior.otherEarningsEarnedSum;
      } else if (row.source === 'adjustment_incentive') {
        if (adjustmentRowCount === 1 && !hasOtherEarningsRow) {
          // Lone adjustment line (no structural Other row): cumulative FY prior for renamed keys.
          prior = totalPriorAdjustment;
        } else if (adjustmentRowCount === 1) {
          const adjKey = normalizeEarningLabel(row.label);
          prior = fyPrior.adjustmentIncentivesByKey.get(adjKey) || 0;
        } else {
          const adjKey = normalizeEarningLabel(row.label);
          const directPrior = fyPrior.adjustmentIncentivesByKey.get(adjKey) || 0;
          let orphanShare = 0;
          if (orphanPriorAdjustment > 0) {
            adjustmentRowIndex += 1;
            if (adjustmentRowIndex === adjustmentRowCount) {
              orphanShare = Number((orphanPriorAdjustment - orphanPriorDistributed).toFixed(2));
            } else {
              orphanShare = Number((orphanPriorAdjustment / adjustmentRowCount).toFixed(2));
            }
            orphanPriorDistributed += orphanShare;
          }
          prior = Number((directPrior + orphanShare).toFixed(2));
        }
      }
      row.ytd = Number((prior + row.earned).toFixed(2));
    }

    type DeductionRow = { label: string; amount: number };
    const deductionRows: DeductionRow[] = [];
    const hasDeductionLabel = new Set<string>();
    // Tracks sum of explicit deduction rows (excluding any derived residuals).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    let deductionComponentTotal = 0;

    const pushDeduction = (label: string, amount: number) => {
      const normalized = label.trim().toLowerCase();
      if (!normalized || hasDeductionLabel.has(normalized)) return;
      const value = Number(amount || 0);
      hasDeductionLabel.add(normalized);
      deductionRows.push({ label, amount: value });
      deductionComponentTotal += value;
    };

    components
      .filter((c) => c.component.type === 'DEDUCTION')
      .forEach(({ component, amount }) => pushDeduction(component.name, Number(amount || 0)));

    if (
      Number(payrollRecord.pf_contribution || 0) > 0 &&
      !hasDeductionLabel.has('provident fund') &&
      !hasDeductionLabel.has('provident fund (pf)')
    ) {
      pushDeduction('Provident Fund', Number(payrollRecord.pf_contribution || 0));
    }
    if (
      Number(payrollRecord.professional_tax || 0) > 0 &&
      !hasDeductionLabel.has('professional tax') &&
      !hasDeductionLabel.has('professional tax (pt)') &&
      !hasDeductionLabel.has('profession tax')
    ) {
      pushDeduction('Professional Tax', Number(payrollRecord.professional_tax || 0));
    }

    // Include named adjustment-only extra deductions (except PF/PT which are shown separately above).
    const adjustmentExtraDeductions: Array<{ name: string; amount: number }> = Array.isArray(
      (payrollRecord as any).adjustment_extra_deductions,
    )
      ? (((payrollRecord as any).adjustment_extra_deductions as Array<{
          name: string;
          amount: number;
        }>) ?? [])
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
      const name = String((d as any)?.name || '').trim();
      const amount = Number((d as any)?.amount || 0);
      if (!name || !Number.isFinite(amount) || amount === 0) continue;
      const n = norm(name);
      if (isPf(n) || isPt(n)) continue;
      pushDeduction(name, amount);
    }

    // Prefer the explicit deduction rows as the table source of truth.
    // Some records store statutory columns (PF/PT) separately from total_deductions.
    // So, after we have built the rows, we derive the displayed TOTAL DEDUCTIONS from row sums.
    const totalDeductionsFromRecord = Number(payrollRecord.total_deductions || 0);
    const deductionRowsTotal = deductionRows.reduce((s, row) => s + Number(row.amount || 0), 0);
    if (totalDeductionsFromRecord - deductionRowsTotal > 0.01) {
      pushDeduction('Other Deductions', totalDeductionsFromRecord - deductionRowsTotal);
    }
    const compressEarningRows = (rows: EarningRow[], maxRows: number): EarningRow[] => {
      if (rows.length <= maxRows) return rows;
      const keepCount = Math.max(1, maxRows - 1);
      const kept = rows.slice(0, keepCount);
      const rest = rows.slice(keepCount);
      const mergedEarned = rest.reduce((sum, row) => sum + row.earned, 0);
      const mergedActual = rest.reduce((sum, row) => sum + row.actual, 0);
      const mergedPrior = rest.reduce(
        (max, row) => Math.max(max, Number((row.ytd - row.earned).toFixed(2))),
        0,
      );
      kept.push({
        label: 'Other Earnings',
        actual: mergedActual,
        earned: Number(mergedEarned.toFixed(2)),
        ytd: Number((mergedPrior + mergedEarned).toFixed(2)),
        source: 'other',
      });
      return kept;
    };

    const compressDeductionRows = (rows: DeductionRow[], maxRows: number): DeductionRow[] => {
      if (rows.length <= maxRows) return rows;
      const keepCount = Math.max(1, maxRows - 1);
      const kept = rows.slice(0, keepCount);
      const rest = rows.slice(keepCount);
      const other = rest.reduce((acc, row) => acc + row.amount, 0);
      kept.push({ label: 'Other Deductions', amount: other });
      return kept;
    };

    y = y + infoHeight + 8;
    const gutter = 10;
    const earningsWidth = Math.floor(pageWidth * 0.65);
    const deductionsWidth = pageWidth - earningsWidth - gutter;
    const tableXLeft = left;
    const tableXRight = left + earningsWidth + gutter;
    const headerHeight = 26;
    const totalRowHeight = 24;
    const minBodyRowHeight = 14;
    const maxBodyRowHeight = 18;

    // Compact, stacked flow: table -> net pay -> reimbursements -> footer.
    const netHeight = 64;
    const reimbursementHeight = 58;
    const tableBottomGap = 8;
    const netBottomGap = 8;
    const footerGap = 36;
    const footerBlockHeight = 24;
    const tableAvailableHeight = Math.max(
      110,
      doc.page.height -
        doc.page.margins.bottom -
        footerBlockHeight -
        footerGap -
        (y + tableBottomGap + netHeight + netBottomGap + reimbursementHeight),
    );

    const rowsByHeight = Math.max(
      2,
      Math.floor((tableAvailableHeight - headerHeight - totalRowHeight) / minBodyRowHeight),
    );
    const earningRowCap = earningRows.length > 3 ? 4 : 3;
    const maxVisibleRows = Math.max(2, Math.min(earningRowCap, rowsByHeight));
    const fittedEarningRows = compressEarningRows(earningRows, maxVisibleRows);
    const fittedDeductionRows = compressDeductionRows(deductionRows, maxVisibleRows);

    const fittedDeductionsRowSum = fittedDeductionRows.reduce(
      (s, row) => s + Number(row.amount || 0),
      0,
    );
    const deductionDelta = Number((deductionsTotalToShow - fittedDeductionsRowSum).toFixed(2));
    if (Math.abs(deductionDelta) > 0.01 && fittedDeductionRows.length > 0) {
      const otherIdx = fittedDeductionRows.findIndex(
        (row) => normalizeEarningLabel(row.label) === 'other deductions',
      );
      const idx = otherIdx >= 0 ? otherIdx : fittedDeductionRows.length - 1;
      fittedDeductionRows[idx].amount = Number(
        (fittedDeductionRows[idx].amount + deductionDelta).toFixed(2),
      );
    }

    const maxRows = Math.max(fittedEarningRows.length, fittedDeductionRows.length);
    const rawRowHeight = Math.floor(
      (tableAvailableHeight - headerHeight - totalRowHeight) / maxRows,
    );
    const bodyRowHeight = Math.max(minBodyRowHeight, Math.min(maxBodyRowHeight, rawRowHeight));
    const earningsHeight = headerHeight + fittedEarningRows.length * bodyRowHeight + totalRowHeight;
    const deductionsHeight =
      headerHeight + fittedDeductionRows.length * bodyRowHeight + totalRowHeight;
    const tableHeight = Math.max(earningsHeight, deductionsHeight);

    drawCard(tableXLeft, y, earningsWidth, tableHeight, '#FFFFFF', '#D8E0EB');
    drawCard(tableXRight, y, deductionsWidth, tableHeight, '#FFFFFF', '#D8E0EB');

    // Column widths for EARNINGS table:
    // - Balance label vs ACTUAL / EARNED / YTD so long names and amounts like "3,99,999.96" fit on one line.
    const earnColWidths = [0.38, 0.21, 0.2, 0.21].map((pct) => pct * earningsWidth);
    drawCard(tableXLeft, y, earningsWidth, headerHeight, '#E9EEF5', '#D8E0EB');
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#334155');
    // Use the same column widths and padding as body cells so headers align perfectly.
    drawCellValue('EARNINGS', tableXLeft, y, earnColWidths[0], 'left');
    drawCellValue('ACTUAL', tableXLeft + earnColWidths[0], y, earnColWidths[1], 'left');
    drawCellValue(
      'EARNED',
      tableXLeft + earnColWidths[0] + earnColWidths[1],
      y,
      earnColWidths[2],
      'left',
    );
    drawCellValue(
      'YTD',
      tableXLeft + earnColWidths[0] + earnColWidths[1] + earnColWidths[2],
      y,
      earnColWidths[3],
      'left',
    );

    let rowY = y + headerHeight;
    doc.font('Helvetica').fontSize(9).fillColor('#374151');
    fittedEarningRows.forEach((row) => {
      doc.rect(tableXLeft, rowY, earningsWidth, bodyRowHeight).stroke('#E5EAF1');
      drawCellValue(row.label, tableXLeft, rowY, earnColWidths[0], 'left');
      drawCellValue(
        currency(row.actual),
        tableXLeft + earnColWidths[0],
        rowY,
        earnColWidths[1],
        'left',
      );
      drawCellValue(
        currency(row.earned),
        tableXLeft + earnColWidths[0] + earnColWidths[1],
        rowY,
        earnColWidths[2],
        'left',
      );
      drawCellValue(
        currency(row.ytd),
        tableXLeft + earnColWidths[0] + earnColWidths[1] + earnColWidths[2],
        rowY,
        earnColWidths[3],
        'left',
      );
      rowY += bodyRowHeight;
    });
    doc.save();
    doc.rect(tableXLeft, rowY, earningsWidth, totalRowHeight).fillAndStroke('#E8F6ED', '#BFE8CC');
    doc.restore();
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#166534');
    const earningsTotalActualAllRows = earningRows.reduce((s, r) => s + r.actual, 0);
    const earningsTotalYtdAllRows = earningRows.reduce((s, r) => s + r.ytd, 0);

    drawCellValue('TOTAL EARNINGS', tableXLeft, rowY, earnColWidths[0], 'left');
    drawCellValue(
      currency(earningsTotalActualAllRows),
      tableXLeft + earnColWidths[0],
      rowY,
      earnColWidths[1],
      'left',
    );
    drawCellValue(
      currency(earningsTotalToShow),
      tableXLeft + earnColWidths[0] + earnColWidths[1],
      rowY,
      earnColWidths[2],
      'left',
    );
    drawCellValue(
      currency(earningsTotalYtdAllRows),
      tableXLeft + earnColWidths[0] + earnColWidths[1] + earnColWidths[2],
      rowY,
      earnColWidths[3],
      'left',
    );

    const dedColWidths = [0.62, 0.38].map((pct) => pct * deductionsWidth);
    drawCard(tableXRight, y, deductionsWidth, headerHeight, '#E9EEF5', '#D8E0EB');
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#334155');
    // Header for deductions column (left aligned)
    drawCellValue('DEDUCTIONS', tableXRight, y, dedColWidths[0], 'left');
    // Render "AMOUNT" with explicit text to keep it on a single line while
    // aligning its left edge with the data column below.
    doc.text('AMOUNT', tableXRight + dedColWidths[0] + 8, y + 8, {
      width: dedColWidths[1], // give full column width to avoid wrapping the last character
      align: 'left',
      lineBreak: false,
    });

    rowY = y + headerHeight;
    doc.font('Helvetica').fontSize(9).fillColor('#374151');
    fittedDeductionRows.forEach((row) => {
      doc.rect(tableXRight, rowY, deductionsWidth, bodyRowHeight).stroke('#E5EAF1');
      drawCellValue(row.label, tableXRight, rowY, dedColWidths[0], 'left');
      drawCellValue(
        currency(row.amount),
        tableXRight + dedColWidths[0],
        rowY,
        dedColWidths[1],
        'left',
      );
      rowY += bodyRowHeight;
    });
    doc.save();
    doc
      .rect(tableXRight, rowY, deductionsWidth, totalRowHeight)
      .fillAndStroke('#FCEAEA', '#F4C2C2');
    doc.restore();
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#B42318');
    drawCellValue('TOTAL DEDUCTIONS', tableXRight, rowY, dedColWidths[0], 'left');
    drawCellValue(
      currency(deductionsTotalToShow),
      tableXRight + dedColWidths[0],
      rowY,
      dedColWidths[1],
      'left',
    );

    y += tableHeight + tableBottomGap;
    drawCard(left, y, pageWidth, netHeight, '#FFF7ED', '#F5D2A7');
    doc.rect(left, y, 4, netHeight).fill('#F97316');
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor('#64748B')
      .text('NET PAY (IN WORDS)', left + 14, y + 14);
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .fillColor('#1E293B')
      .text(`${numberToWords(Math.floor(Math.max(netSalary, 0)))} Rupees Only`, left + 14, y + 30, {
        width: pageWidth * 0.6,
        lineBreak: false,
        ellipsis: true,
      });
    const netBlockWidth = 160;
    const netBlockX = left + pageWidth - netBlockWidth - 20;
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#64748B')
      .text('NET SALARY PAYABLE', netBlockX, y + 14, {
        width: netBlockWidth,
        align: 'left',
      });
    doc
      .font('Helvetica-Bold')
      .fontSize(20)
      .fillColor('#0F172A')
      .text(currency(netSalary), netBlockX, y + 34, {
        width: netBlockWidth,
        align: 'left',
      });

    y += netHeight + netBottomGap;
    drawCard(left, y, pageWidth, reimbursementHeight, '#F8FAFC', '#D8E0EB');
    drawCard(left, y, pageWidth, 24, '#E9EEF5', '#D8E0EB');
    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor('#334155')
      .text('REIMBURSEMENTS', left + 12, y + 8);
    const reimbursementCols = 3;
    const reimbursementColWidth = (pageWidth - 24) / reimbursementCols;
    const reimbursementItems: Array<[string, number]> = [
      ['ACTUAL REIMBURSEMENT', 0],
      ['EARNED REIMBURSEMENT', 0],
      ['TOTAL REIMBURSEMENT', 0],
    ];
    reimbursementItems.forEach(([label, amount], index) => {
      const x = left + 12 + index * reimbursementColWidth;
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor('#64748B')
        .text(label, x, y + 34, {
          width: reimbursementColWidth - 8,
          lineBreak: false,
          ellipsis: true,
        });
      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .fillColor('#111827')
        .text(currency(amount), x, y + 48, {
          width: reimbursementColWidth - 8,
          lineBreak: false,
          ellipsis: true,
        });
    });

    const footerBaseY = Math.min(
      y + reimbursementHeight + footerGap,
      doc.page.height - doc.page.margins.bottom - 10,
    );
    const signatoryLabelY = footerBaseY - 12;

    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#6B7280')
      .text(
        'This is a computer-generated document and does not require a signature.',
        left,
        footerBaseY,
        {
          width: pageWidth * 0.58,
          align: 'left',
          lineBreak: false,
          ellipsis: true,
        },
      );
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#6B7280')
      .text('Authorized Signatory', left + pageWidth - 150, signatoryLabelY, {
        width: 150,
        align: 'right',
        lineBreak: false,
        ellipsis: true,
      });
    doc
      .font('Helvetica-Bold')
      .fontSize(8)
      .fillColor('#1F2937')
      .text(organizationName || 'Organization', left + pageWidth - 150, footerBaseY, {
        width: 150,
        align: 'right',
        lineBreak: false,
        ellipsis: true,
      });

    doc.end();
    await new Promise<void>((resolve) => {
      doc.on('end', resolve);
    });
    return Buffer.concat(chunks);
  }
}
