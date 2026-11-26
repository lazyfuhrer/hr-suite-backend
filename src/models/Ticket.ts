import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class Ticket extends BaseModel {
  static tableName = 'tickets';

  static get relationMappings() {
    const { Organization } = require('./Organization');
    const { User } = require('./User');

    return {
      organization: {
        relation: Model.BelongsToOneRelation,
        modelClass: Organization,
        join: {
          from: 'tickets.org_id',
          to: 'organizations.id',
        },
      },
      raiser: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'tickets.raiser_id',
          to: 'users.id',
        },
      },
      assignee: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'tickets.assigned_to',
          to: 'users.id',
        },
      },
    };
  }
}
