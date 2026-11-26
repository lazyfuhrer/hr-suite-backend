import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class SalaryComponent extends BaseModel {
  static tableName = 'salary_components';

  org_id!: string;
  name!: string;
  code!: string;
  type!: 'EARNING' | 'DEDUCTION' | 'ALLOWANCE' | 'BONUS' | 'OVERTIME' | 'INCENTIVE';
  is_taxable!: boolean;
  is_pf_applicable!: boolean;
  is_esi_applicable!: boolean;
  display_order!: number;
  is_active!: boolean;
  deleted_at?: Date;

  static get relationMappings() {
    const { Organization } = require('./Organization');

    return {
      organization: {
        relation: Model.BelongsToOneRelation,
        modelClass: Organization,
        join: {
          from: 'salary_components.org_id',
          to: 'organizations.id',
        },
      },
    };
  }
}
