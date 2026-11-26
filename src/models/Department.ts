import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class Department extends BaseModel {
  static tableName = 'departments';

  org_id!: string;
  name!: string;
  manager_id?: string | null;
  location_id?: string | null;
  default_shift_id?: string | null;
  location_ids?: string[] | null;
  work_shift_ids?: string[] | null;
  working_days?: string[] | null;
  location_tracking_enabled!: boolean;
  deleted_at?: Date | null;

  static get relationMappings() {
    const { Organization } = require('./Organization');
    const { User } = require('./User');
    const { OfficeLocation } = require('./OfficeLocation');
    const { WorkShift } = require('./WorkShift');

    return {
      organization: {
        relation: Model.BelongsToOneRelation,
        modelClass: Organization,
        join: {
          from: 'departments.org_id',
          to: 'organizations.id',
        },
      },
      users: {
        relation: Model.HasManyRelation,
        modelClass: User,
        join: {
          from: 'departments.id',
          to: 'users.department_id',
        },
      },
      manager: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'departments.manager_id',
          to: 'users.id',
        },
      },
      managers: {
        relation: Model.ManyToManyRelation,
        modelClass: User,
        join: {
          from: 'departments.id',
          through: {
            from: 'department_managers.department_id',
            to: 'department_managers.manager_id',
          },
          to: 'users.id',
        },
      },
      location: {
        relation: Model.BelongsToOneRelation,
        modelClass: OfficeLocation,
        join: {
          from: 'departments.location_id',
          to: 'office_locations.id',
        },
      },
      defaultShift: {
        relation: Model.BelongsToOneRelation,
        modelClass: WorkShift,
        join: {
          from: 'departments.default_shift_id',
          to: 'work_shifts.id',
        },
      },
    };
  }
}
