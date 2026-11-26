import { Model } from 'objection';
import type { User } from './User';
import type { LeaveType } from './LeaveType';

import { BaseModel } from './BaseModel';

export type LeaveDaySession = 'FULL' | 'FIRST_HALF' | 'SECOND_HALF';

export class LeaveRequest extends BaseModel {
  static tableName = 'leave_requests';

  org_id!: string;
  user_id!: string;
  manager_id?: string | null;
  leave_type_id!: string;
  start_date!: string;
  end_date!: string;
  reason?: string | null;
  status!: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  day_session!: LeaveDaySession;
  total_days?: number | null;
  attachment_url?: string | null;
  approver_comment?: string | null;
  cancelled_at?: string | Date | null;
  cancelled_by?: string | null;
  updated_by?: string | null;

  // Multi-stage approvals
  manager_status?: 'PENDING' | 'APPROVED' | 'REJECTED';
  hr_status?: 'PENDING' | 'APPROVED' | 'REJECTED';
  hr_id?: string | null;
  manager_action_at?: string | null;
  hr_action_at?: string | null;

  // Relations (populated when using withGraphJoined / eager)
  user?: User;
  manager?: User;
  leaveType?: LeaveType;

  static get relationMappings() {
    const { Organization } = require('./Organization');
    const { User } = require('./User');
    const { LeaveType } = require('./LeaveType');

    return {
      organization: {
        relation: Model.BelongsToOneRelation,
        modelClass: Organization,
        join: {
          from: 'leave_requests.org_id',
          to: 'organizations.id',
        },
      },
      user: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'leave_requests.user_id',
          to: 'users.id',
        },
      },
      manager: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'leave_requests.manager_id',
          to: 'users.id',
        },
      },
      leaveType: {
        relation: Model.BelongsToOneRelation,
        modelClass: LeaveType,
        join: {
          from: 'leave_requests.leave_type_id',
          to: 'leave_types.id',
        },
      },
    };
  }
}
