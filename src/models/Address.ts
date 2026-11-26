import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class Address extends BaseModel {
  static tableName = 'addresses';

  user_id!: string;
  type!: string;
  street_address?: string;
  city?: string;
  state?: string;
  zip_code?: string;
  country?: string;

  static get relationMappings() {
    const { User } = require('./User');

    return {
      user: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'addresses.user_id',
          to: 'users.id',
        },
      },
    };
  }
}
