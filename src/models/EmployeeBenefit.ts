import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class EmployeeBenefit extends BaseModel {
  static tableName = 'employee_benefits';

  user_id!: string;
  benefit_type!: string;
  enabled!: boolean;

  static get relationMappings() {
    const { User } = require('./User');

    return {
      user: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'employee_benefits.user_id',
          to: 'users.id',
        },
      },
    };
  }
}
