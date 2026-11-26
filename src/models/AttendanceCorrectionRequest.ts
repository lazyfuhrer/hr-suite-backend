import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class AttendanceCorrectionRequest extends BaseModel {
  static tableName = 'attendance_correction_requests';

  user_id!: string;
  attendance_log_id?: string | null;
  request_date!: string;
  requested_clock_in!: string;
  requested_clock_out!: string;
  reason?: string | null;
  status!: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  approver_id?: string | null;
  cancelled_at?: string | Date | null;
  cancelled_by?: string | null;
  updated_by?: string | null;

  // Regularization metadata
  wrong_punch_type?:
    | 'MISSING_IN'
    | 'MISSING_OUT'
    | 'WRONG_IN'
    | 'WRONG_OUT'
    | 'CLOCK_IN'
    | 'CLOCK_OUT'
    | 'BREAKS'
    | null;
  corrected_time?: string | null; // HH:MM from UI
  /** Snapshot of the punch timestamp before correction (ISO); list APIs prefer this over live logs after approval. */
  original_punch_time?: string | Date | null;
  attachment_url?: string | null;

  // Optional JSON payload describing break corrections when wrong_punch_type = BREAKS
  // Shape: [{ break_type, corrected_start_time, corrected_end_time }, ...]
  break_corrections?: Array<{
    break_type: string;
    corrected_start_time: string;
    corrected_end_time: string;
  }> | null;

  // Multi-stage approvals
  manager_status?: 'PENDING' | 'APPROVED' | 'REJECTED';
  hr_status?: 'PENDING' | 'APPROVED' | 'REJECTED';
  manager_id?: string | null;
  hr_id?: string | null;
  manager_action_at?: string | null;
  hr_action_at?: string | null;
  approver_comment?: string | null;

  static get relationMappings() {
    const { User } = require('./User');
    const { AttendanceLog } = require('./AttendanceLog');

    return {
      user: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'attendance_correction_requests.user_id',
          to: 'users.id',
        },
      },
      attendanceLog: {
        relation: Model.BelongsToOneRelation,
        modelClass: AttendanceLog,
        join: {
          from: 'attendance_correction_requests.attendance_log_id',
          to: 'attendance_logs.id',
        },
      },
      approver: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'attendance_correction_requests.approver_id',
          to: 'users.id',
        },
      },
      manager: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'attendance_correction_requests.manager_id',
          to: 'users.id',
        },
      },
      hr: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'attendance_correction_requests.hr_id',
          to: 'users.id',
        },
      },
    };
  }
}
