import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class UserProfile extends BaseModel {
  static tableName = 'user_profiles';

  user_id!: string;
  gender?: string;
  marital_status?: string;
  dob?: string;
  nationality?: string;
  personal_email?: string;
  personal_phone?: string;
  alt_phone?: string;

  blood_group?: string;
  emergency_contact_name?: string;
  emergency_contact_phone?: string;
  permanent_address?: string;
  present_address?: string;
  user: any;
  static get relationMappings() {
    const { User } = require('./User');

    return {
      user: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'user_profiles.user_id',
          to: 'users.id',
        },
      },
    };
  }
}
