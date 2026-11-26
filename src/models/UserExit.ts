import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export type UserExitType =
  | 'RESIGNATION'
  | 'TERMINATION'
  | 'RETIREMENT'
  | 'END_OF_CONTRACT'
  | 'OTHER';

export type UserExitStatus = 'SCHEDULED' | 'ON_NOTICE' | 'COMPLETED' | 'CANCELLED';

export class UserExit extends BaseModel {
  static tableName = 'user_exits';

  org_id!: string;
  user_id!: string;
  exit_type!: UserExitType;
  exit_reason?: string | null;
  notice_start_date?: string | null;
  last_working_day!: string;
  exited_at?: Date | string | null;
  status!: UserExitStatus;
  initiated_by?: string | null;
  confirmed_by?: string | null;
  cancelled_by?: string | null;
  initiated_at!: Date | string;
  confirmed_at?: Date | string | null;
  cancelled_at?: Date | string | null;

  static get relationMappings() {
    const { User } = require('./User');
    const { Organization } = require('./Organization');

    return {
      user: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'user_exits.user_id',
          to: 'users.id',
        },
      },
      organization: {
        relation: Model.BelongsToOneRelation,
        modelClass: Organization,
        join: {
          from: 'user_exits.org_id',
          to: 'organizations.id',
        },
      },
      initiatedByUser: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'user_exits.initiated_by',
          to: 'users.id',
        },
      },
    };
  }
}
