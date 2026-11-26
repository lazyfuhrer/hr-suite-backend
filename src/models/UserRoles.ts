import { Model } from 'objection';
import { User } from './User';
import { Roles } from './Roles';

export class UserRole extends Model {
  static get tableName() {
    return 'users_roles';
  }

  id!: string;
  role_id!: string;
  user_id!: string;
  created_at?: string;
  updated_at?: string;

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['role_id', 'user_id'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        role_id: { type: 'string' },
        user_id: { type: 'string', format: 'uuid' },
      },
    };
  }

  static get relationMappings() {
    return {
      user: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'users_roles.user_id',
          to: 'users.id',
        },
      },
      role: {
        relation: Model.BelongsToOneRelation,
        modelClass: Roles,
        join: {
          from: 'users_roles.role_id',
          to: 'roles.id',
        },
      },
    };
  }
}
