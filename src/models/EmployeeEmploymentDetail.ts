import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class EmployeeEmploymentDetail extends BaseModel {
  static tableName = 'employee_employment_details';

  user_id!: string;
  employment_type?: string;
  work_mode?: string;
  base_salary?: number;
  annual_ctc?: number;
  currency?: string;
  notes?: string;

  static get relationMappings() {
    const { User } = require('./User');

    return {
      user: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'employee_employment_details.user_id',
          to: 'users.id',
        },
      },
    };
  }
}
