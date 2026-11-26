import { Model } from 'objection';

export class SuperAdminRole extends Model {
  static tableName = 'super_admins_roles';

  id!: string;
  super_admin_id!: string;
  role_id!: string;

  static get jsonSchema() {
    return {
      type: 'object',

      required: ['super_admin_id', 'role_id'],

      properties: {
        id: { type: 'string', format: 'uuid' },
        super_admin_id: { type: 'string', format: 'uuid' },
        role_id: { type: 'string' },
      },
    };
  }
}
