import { Model } from 'objection';
import type { User } from './User';

import { BaseModel } from './BaseModel';

export class WfhRequest extends BaseModel {
  static tableName = 'wfh_requests';

  org_id!: string;
  user_id!: string;
  manager_id?: string | null;
  hr_id?: string | null;
  start_date!: string;
  end_date!: string;
  reason!: string;
  status!: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  total_days?: number | null;
  attachment_url?: string | null;
  approver_comment?: string | null;
  cancelled_at?: string | Date | null;
  cancelled_by?: string | null;
  updated_by?: string | null;

  manager_status?: 'PENDING' | 'APPROVED' | 'REJECTED';
  hr_status?: 'PENDING' | 'APPROVED' | 'REJECTED';
  manager_action_at?: string | null;
  hr_action_at?: string | null;

  user?: User;
  manager?: User;

  static get relationMappings() {
    const { Organization } = require('./Organization');
    const { User } = require('./User');

    return {
      organization: {
        relation: Model.BelongsToOneRelation,
        modelClass: Organization,
        join: {
          from: 'wfh_requests.org_id',
          to: 'organizations.id',
        },
      },
      user: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'wfh_requests.user_id',
          to: 'users.id',
        },
      },
      manager: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'wfh_requests.manager_id',
          to: 'users.id',
        },
      },
    };
  }
}
