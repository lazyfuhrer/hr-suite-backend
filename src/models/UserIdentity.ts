import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class UserIdentity extends BaseModel {
  static tableName = 'user_identities';

  user_id!: string;
  id_type!: string;
  id_number!: string;
  name_on_document?: string;
  valid_till?: string;

  static get relationMappings() {
    const { User } = require('./User');

    return {
      user: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'user_identities.user_id',
          to: 'users.id',
        },
      },
    };
  }
}
