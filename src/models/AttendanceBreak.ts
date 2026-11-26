import { Model } from 'objection';

export class AttendanceBreak extends Model {
  static tableName = 'attendance_breaks';

  // Columns
  id!: number;
  attendance_log_id!: string;
  break_type!: 'LUNCH' | 'TEA';
  start_time!: string;
  end_time?: string | null;

  static get relationMappings() {
    const { AttendanceLog } = require('./AttendanceLog');

    return {
      attendanceLog: {
        relation: Model.BelongsToOneRelation,
        modelClass: AttendanceLog,
        join: {
          from: 'attendance_breaks.attendance_log_id',
          to: 'attendance_logs.id',
        },
      },
    };
  }
}
