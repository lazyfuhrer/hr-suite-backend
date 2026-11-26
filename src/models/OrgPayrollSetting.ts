import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export type PfValueType = 'PERCENTAGE' | 'FIXED';

export class OrgPayrollSetting extends BaseModel {
  static tableName = 'org_payroll_settings';

  org_id!: string;

  basic_pct!: number;
  hra_pct_of_basic!: number;

  employer_pf_type!: PfValueType;
  employer_pf_value!: number;

  employee_pf_type!: PfValueType;
  employee_pf_value!: number;

  professional_tax_annual!: number;

  static get relationMappings() {
    const { Organization } = require('./Organization');

    return {
      organization: {
        relation: Model.BelongsToOneRelation,
        modelClass: Organization,
        join: {
          from: 'org_payroll_settings.org_id',
          to: 'organizations.id',
        },
      },
    };
  }
}
