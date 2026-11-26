import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class AttendanceHalfDayNoPunchPenalty extends BaseModel {
  static tableName = 'attendance_half_day_no_punch_penalties';

  org_id!: string;
  user_id!: string;
  penalty_date!: string;
  original_leave_request_id!: string;
  supplemental_leave_request_id?: string | null;
  lop_days!: number;
  processed_at!: string | Date;

  static get relationMappings() {
    const { Organization } = require('./Organization');
    const { User } = require('./User');
    const { LeaveRequest } = require('./LeaveRequest');

    return {
      organization: {
        relation: Model.BelongsToOneRelation,
        modelClass: Organization,
        join: {
          from: 'attendance_half_day_no_punch_penalties.org_id',
          to: 'organizations.id',
        },
      },
      user: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'attendance_half_day_no_punch_penalties.user_id',
          to: 'users.id',
        },
      },
      originalLeaveRequest: {
        relation: Model.BelongsToOneRelation,
        modelClass: LeaveRequest,
        join: {
          from: 'attendance_half_day_no_punch_penalties.original_leave_request_id',
          to: 'leave_requests.id',
        },
      },
      supplementalLeaveRequest: {
        relation: Model.BelongsToOneRelation,
        modelClass: LeaveRequest,
        join: {
          from: 'attendance_half_day_no_punch_penalties.supplemental_leave_request_id',
          to: 'leave_requests.id',
        },
      },
    };
  }
}
