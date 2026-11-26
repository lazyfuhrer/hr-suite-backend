import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class PayrollRecord extends BaseModel {
  static tableName = 'payroll_records';

  static get jsonAttributes() {
    return ['component_breakdown', 'adjustment_incentives', 'adjustment_extra_deductions'];
  }

  user_id!: string;
  org_id!: string;
  payroll_month!: number;
  payroll_year!: number;
  salary_structure_id?: string;
  gross_salary!: number;
  total_earnings!: number;
  total_deductions!: number;
  net_salary!: number;
  pf_contribution?: number;
  professional_tax?: number;
  overtime_amount?: number;
  incentive_amount?: number;
  bonus_amount?: number;
  allowance_amount?: number;
  component_breakdown!: Record<string, number>;
  adjustment_incentives?: Array<{ name: string; amount: number }>;
  adjustment_extra_deductions?: Array<{ name: string; amount: number }>;
  payslip_pdf_url?: string;
  status!: 'PENDING' | 'ADJUSTED' | 'PAID' | 'DRAFT' | 'PROCESSED' | 'CANCELLED';
  notes?: string;
  processed_at?: Date;
  paid_at?: Date;

  static get relationMappings() {
    const { User } = require('./User');
    const { Organization } = require('./Organization');
    const { SalaryStructure } = require('./SalaryStructure');

    return {
      user: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'payroll_records.user_id',
          to: 'users.id',
        },
      },
      organization: {
        relation: Model.BelongsToOneRelation,
        modelClass: Organization,
        join: {
          from: 'payroll_records.org_id',
          to: 'organizations.id',
        },
      },
      salaryStructure: {
        relation: Model.BelongsToOneRelation,
        modelClass: SalaryStructure,
        join: {
          from: 'payroll_records.salary_structure_id',
          to: 'salary_structures.id',
        },
      },
    };
  }
}
