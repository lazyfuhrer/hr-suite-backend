import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class OfficeLocation extends BaseModel {
  static tableName = 'office_locations';

  org_id!: string;
  name!: string;
  latitude!: string;
  longitude!: string;
  radius_meters!: number;
  address?: string;

  static get relationMappings() {
    const { Organization } = require('./Organization');
    const { Department } = require('./Department');

    return {
      organization: {
        relation: Model.BelongsToOneRelation,
        modelClass: Organization,
        join: {
          from: 'office_locations.org_id',
          to: 'organizations.id',
        },
      },
      departments: {
        relation: Model.HasManyRelation,
        modelClass: Department,
        join: {
          from: 'office_locations.id',
          to: 'departments.location_id',
        },
      },
    };
  }
}
