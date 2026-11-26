import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class AttendanceLog extends BaseModel {
  static tableName = 'attendance_logs';

  org_id!: string;
  user_id!: string;
  date!: string;
  clock_in_time?: string | null;
  clock_out_time?: string | null;
  total_work_hours?: number | null;
  status!: string;
  punch_in_lat?: string | null;
  punch_in_long?: string | null;
  punch_out_lat?: string | null;
  punch_out_long?: string | null;
  overtime_minutes?: number | null;
  imported_at?: string | Date | null;
  imported_by_user_id?: string | null;

  static get relationMappings() {
    const { Organization } = require('./Organization');
    const { User } = require('./User');
    const { AttendanceBreak } = require('./AttendanceBreak');

    return {
      organization: {
        relation: Model.BelongsToOneRelation,
        modelClass: Organization,
        join: {
          from: 'attendance_logs.org_id',
          to: 'organizations.id',
        },
      },
      user: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'attendance_logs.user_id',
          to: 'users.id',
        },
      },
      breaks: {
        relation: Model.HasManyRelation,
        modelClass: AttendanceBreak,
        join: {
          from: 'attendance_logs.id',
          to: 'attendance_breaks.attendance_log_id',
        },
      },
    };
  }
}
