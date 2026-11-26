import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class UserPayrollDetail extends BaseModel {
  static tableName = 'user_payroll_details';

  user_id!: string;
  pan_number?: string;
  aadhaar_number?: string;
  pf_number?: string;
  uan_number?: string;
  esi_number?: string;
  tax_saving_investments?: string;
  declared_tax?: number;

  static get relationMappings() {
    const { User } = require('./User');

    return {
      user: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'user_payroll_details.user_id',
          to: 'users.id',
        },
      },
    };
  }
}
