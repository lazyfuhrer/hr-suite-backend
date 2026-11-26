import type { OrgPayrollSetting } from '../models/OrgPayrollSetting';

export type PayrollSettingsPfInput = { type: 'PERCENTAGE' | 'FIXED'; value: number };

export type PayrollSettingsInput = {
  basic_pct: number;
  hra_pct_of_basic: number;
  employer_pf: PayrollSettingsPfInput;
  employee_pf: PayrollSettingsPfInput;
  professional_tax_annual: number;
};

export type PayrollSettingsBreakdown = {
  basic: number;
  hra: number;
  employer_pf: number;
  other_allowance: number;
  gross: number;
  employee_pf: number;
  professional_tax: number;
  total_deductions: number;
  net_monthly: number;
  ctc_check: number;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function normalizeOrgPayrollSetting(setting: OrgPayrollSetting): PayrollSettingsInput {
  return {
    basic_pct: Number(setting.basic_pct),
    hra_pct_of_basic: Number(setting.hra_pct_of_basic),
    employer_pf: {
      type: setting.employer_pf_type,
      value: Number(setting.employer_pf_value),
    },
    employee_pf: {
      type: setting.employee_pf_type,
      value: Number(setting.employee_pf_value),
    },
    professional_tax_annual: Number(setting.professional_tax_annual),
  };
}

export function computePayrollSettingsBreakdown(params: {
  annual_ctc: number;
  settings: PayrollSettingsInput;
}): PayrollSettingsBreakdown {
  const { annual_ctc, settings } = params;

  const basic = round2((annual_ctc * settings.basic_pct) / 100);
  const hra = round2((basic * settings.hra_pct_of_basic) / 100);

  const employer_pf = round2(
    settings.employer_pf.type === 'PERCENTAGE'
      ? (basic * settings.employer_pf.value) / 100
      : settings.employer_pf.value,
  );

  const other_allowance = round2(annual_ctc - (basic + hra + employer_pf));
  const gross = round2(basic + hra + other_allowance);

  const employee_pf = round2(
    settings.employee_pf.type === 'PERCENTAGE'
      ? (basic * settings.employee_pf.value) / 100
      : settings.employee_pf.value,
  );

  const professional_tax = round2(settings.professional_tax_annual);
  const total_deductions = round2(employee_pf + professional_tax);
  const net_monthly = round2((gross - total_deductions) / 12);
  const ctc_check = round2(gross + employer_pf);

  return {
    basic,
    hra,
    employer_pf,
    other_allowance,
    gross,
    employee_pf,
    professional_tax,
    total_deductions,
    net_monthly,
    ctc_check,
  };
}
