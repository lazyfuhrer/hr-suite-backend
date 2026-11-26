import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class ActivityLog extends BaseModel {
  static tableName = 'activity_logs';

  org_id!: string;
  actor_user_id?: string | null;
  target_user_id?: string | null;
  entity_type!: string;
  entity_id?: string | null;
  activity_type!: string;
  metadata?: Record<string, unknown> | null;

  static get relationMappings() {
    const { Organization } = require('./Organization');
    const { User } = require('./User');

    return {
      organization: {
        relation: Model.BelongsToOneRelation,
        modelClass: Organization,
        join: {
          from: 'activity_logs.org_id',
          to: 'organizations.id',
        },
      },
      actor: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'activity_logs.actor_user_id',
          to: 'users.id',
        },
      },
      target: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'activity_logs.target_user_id',
          to: 'users.id',
        },
      },
    };
  }
}
