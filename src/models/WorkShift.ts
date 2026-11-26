import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class WorkShift extends BaseModel {
  static tableName = 'work_shifts';

  org_id!: string;
  name!: string;
  start_time!: string;
  end_time!: string;
  break_start_time!: string;
  break_end_time!: string;
  break_duration_mins!: number;

  static get relationMappings() {
    const { Organization } = require('./Organization');
    const { Department } = require('./Department');
    const { User } = require('./User');

    return {
      organization: {
        relation: Model.BelongsToOneRelation,
        modelClass: Organization,
        join: {
          from: 'work_shifts.org_id',
          to: 'organizations.id',
        },
      },
      departments: {
        relation: Model.HasManyRelation,
        modelClass: Department,
        join: {
          from: 'work_shifts.id',
          to: 'departments.default_shift_id',
        },
      },
      users: {
        relation: Model.HasManyRelation,
        modelClass: User,
        join: {
          from: 'work_shifts.id',
          to: 'users.shift_id',
        },
      },
    };
  }
}
