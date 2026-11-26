import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class Geofence extends BaseModel {
  static tableName = 'geofences';

  org_id!: string;
  user_id!: string;
  landmark!: string;
  latitude!: string;
  longitude!: string;
  radius_meters!: number;

  static get relationMappings() {
    const { Organization } = require('./Organization');
    const { User } = require('./User');

    return {
      organization: {
        relation: Model.BelongsToOneRelation,
        modelClass: Organization,
        join: {
          from: 'geofences.org_id',
          to: 'organizations.id',
        },
      },
      user: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'geofences.user_id',
          to: 'users.id',
        },
      },
    };
  }
}
