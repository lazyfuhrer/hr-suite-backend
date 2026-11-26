import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class GeofenceEvent extends BaseModel {
  static tableName = 'geofence_events';

  org_id!: string;
  geofence_id!: string;
  user_id!: string;
  event_type!: 'in' | 'out';
  latitude!: string | null;
  longitude!: string | null;
  recorded_at!: Date;

  static get relationMappings() {
    const { Organization } = require('./Organization');
    const { Geofence } = require('./Geofence');
    const { User } = require('./User');

    return {
      organization: {
        relation: Model.BelongsToOneRelation,
        modelClass: Organization,
        join: {
          from: 'geofence_events.org_id',
          to: 'organizations.id',
        },
      },
      geofence: {
        relation: Model.BelongsToOneRelation,
        modelClass: Geofence,
        join: {
          from: 'geofence_events.geofence_id',
          to: 'geofences.id',
        },
      },
      user: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'geofence_events.user_id',
          to: 'users.id',
        },
      },
    };
  }
}
