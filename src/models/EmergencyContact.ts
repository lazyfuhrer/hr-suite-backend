import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class EmergencyContact extends BaseModel {
  static tableName = 'emergency_contacts';

  user_id!: string;
  name!: string;
  relation!: string;
  phone!: string;
  email?: string;
  is_primary!: boolean;

  static get relationMappings() {
    const { User } = require('./User');

    return {
      user: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'emergency_contacts.user_id',
          to: 'users.id',
        },
      },
    };
  }
}
