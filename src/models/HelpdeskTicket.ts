import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class HelpdeskTicket extends BaseModel {
  static tableName = 'helpdesk_tickets';

  org_id!: string;
  created_by!: string;
  assigned_to?: string | null;

  category!: 'it_support' | 'hr_query' | 'payroll' | 'attendance' | 'leave';
  subject!: string;
  description!: string;
  priority!: 'LOW' | 'MEDIUM' | 'HIGH';
  status!: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'REOPENED';

  leave_request_id?: string | null;
  attendance_correction_request_id?: string | null;

  attachment_file_key?: string | null;
  attachment_file_url?: string | null;

  static get relationMappings() {
    const { Organization } = require('./Organization');
    const { User } = require('./User');
    const { LeaveRequest } = require('./LeaveRequest');
    const { AttendanceCorrectionRequest } = require('./AttendanceCorrectionRequest');
    const { HelpdeskTicketComment } = require('./HelpdeskTicketComment');

    return {
      organization: {
        relation: Model.BelongsToOneRelation,
        modelClass: Organization,
        join: {
          from: 'helpdesk_tickets.org_id',
          to: 'organizations.id',
        },
      },
      creator: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'helpdesk_tickets.created_by',
          to: 'users.id',
        },
      },
      assignee: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'helpdesk_tickets.assigned_to',
          to: 'users.id',
        },
      },
      leaveRequest: {
        relation: Model.BelongsToOneRelation,
        modelClass: LeaveRequest,
        join: {
          from: 'helpdesk_tickets.leave_request_id',
          to: 'leave_requests.id',
        },
      },
      attendanceCorrectionRequest: {
        relation: Model.BelongsToOneRelation,
        modelClass: AttendanceCorrectionRequest,
        join: {
          from: 'helpdesk_tickets.attendance_correction_request_id',
          to: 'attendance_correction_requests.id',
        },
      },
      comments: {
        relation: Model.HasManyRelation,
        modelClass: HelpdeskTicketComment,
        join: {
          from: 'helpdesk_tickets.id',
          to: 'helpdesk_ticket_comments.ticket_id',
        },
      },
    };
  }
}
