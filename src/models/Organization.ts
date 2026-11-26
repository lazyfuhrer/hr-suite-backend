import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class Organization extends BaseModel {
  static tableName = 'organizations';

  name!: string;
  company_code!: string;
  contact_email!: string;
  subscription_status!: string;
  expires_at!: string;
  max_users!: number;
  late_grace_period_mins!: number;
  deleted_at?: string | null;
  logo_url?: string;
  favicon_url?: string;
  brand_color?: string;
  website?: string;
  founded_year?: number;
  address?: string;
  phone_number?: string;
  cin?: string;
  gstin?: string;
  pf_number?: string;
  face_clock_enabled?: boolean;
  kyc_flow_enabled?: boolean;
  display_ot?: boolean;
  ot_round_off_enabled?: boolean;
  ot_round_off_mins?: number;

  static get relationMappings() {
    const { User } = require('./User');
    const { Department } = require('./Department');

    return {
      users: {
        relation: Model.HasManyRelation,
        modelClass: User,
        join: {
          from: 'organizations.id',
          to: 'users.org_id',
        },
      },
      departments: {
        relation: Model.HasManyRelation,
        modelClass: Department,
        join: {
          from: 'organizations.id',
          to: 'departments.org_id',
        },
      },
    };
  }
}
