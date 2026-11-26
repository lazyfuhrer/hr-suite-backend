import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class UserHolidayOverride extends BaseModel {
  static tableName = 'user_holiday_overrides';

  org_id!: string;
  user_id!: string;
  holiday_id!: string;
  enabled!: boolean;

  static get relationMappings() {
    const { Organization } = require('./Organization');
    const { User } = require('./User');
    const { Holiday } = require('./Holiday');

    return {
      organization: {
        relation: Model.BelongsToOneRelation,
        modelClass: Organization,
        join: {
          from: 'user_holiday_overrides.org_id',
          to: 'organizations.id',
        },
      },
      user: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'user_holiday_overrides.user_id',
          to: 'users.id',
        },
      },
      holiday: {
        relation: Model.BelongsToOneRelation,
        modelClass: Holiday,
        join: {
          from: 'user_holiday_overrides.holiday_id',
          to: 'holidays.id',
        },
      },
    };
  }
}
