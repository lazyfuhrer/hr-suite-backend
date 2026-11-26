import { Model } from 'objection';

export class Roles extends Model {
  static tableName = 'roles';

  id!: string;
  name!: string;
  description!: string;

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['id', 'name', 'description'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string', minLength: 1 },
        description: { type: 'string', minLength: 1 },
      },
    };
  }
}
