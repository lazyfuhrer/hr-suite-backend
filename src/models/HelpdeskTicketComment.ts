import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class HelpdeskTicketComment extends BaseModel {
  static tableName = 'helpdesk_ticket_comments';

  ticket_id!: string;
  org_id!: string;
  user_id!: string;
  message!: string;
  file_key?: string | null;
  file_url?: string | null;

  static get relationMappings() {
    const { HelpdeskTicket } = require('./HelpdeskTicket');
    const { User } = require('./User');

    return {
      ticket: {
        relation: Model.BelongsToOneRelation,
        modelClass: HelpdeskTicket,
        join: {
          from: 'helpdesk_ticket_comments.ticket_id',
          to: 'helpdesk_tickets.id',
        },
      },
      user: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'helpdesk_ticket_comments.user_id',
          to: 'users.id',
        },
      },
    };
  }
}
