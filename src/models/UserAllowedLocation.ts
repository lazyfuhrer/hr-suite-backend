import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class UserAllowedLocation extends BaseModel {
  static tableName = 'user_allowed_locations';

  org_id!: string;
  user_id!: string;
  latitude!: string;
  longitude!: string;
  radius_meters!: number;
  label?: string | null;
  is_active!: boolean;

  static get relationMappings() {
    const { Organization } = require('./Organization');
    const { User } = require('./User');

    return {
      organization: {
        relation: Model.BelongsToOneRelation,
        modelClass: Organization,
        join: {
          from: 'user_allowed_locations.org_id',
          to: 'organizations.id',
        },
      },
      user: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'user_allowed_locations.user_id',
          to: 'users.id',
        },
      },
    };
  }
}
