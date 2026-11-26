import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class SalaryStructure extends BaseModel {
  static tableName = 'salary_structures';

  user_id!: string;
  org_id!: string;
  effective_from!: Date;
  effective_to?: Date;
  gross_salary!: number;
  net_salary!: number;
  employer_total_contributions!: number; // Annual
  component_breakdown!: Record<string, number>; // { component_id: amount }
  notes?: string;
  hike_percentage?: number;
  is_active!: boolean;
  deleted_at?: Date;

  static get relationMappings() {
    const { User } = require('./User');
    const { Organization } = require('./Organization');

    return {
      user: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'salary_structures.user_id',
          to: 'users.id',
        },
      },
      organization: {
        relation: Model.BelongsToOneRelation,
        modelClass: Organization,
        join: {
          from: 'salary_structures.org_id',
          to: 'organizations.id',
        },
      },
    };
  }
}
