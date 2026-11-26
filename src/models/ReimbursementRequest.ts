import { Model } from 'objection';
import type { ReimbursementPaymentStatus } from '../constants/reimbursement-payment';
import type { ReimbursementType } from '../constants/reimbursement-type';
import type { User } from './User';

import { BaseModel } from './BaseModel';

export class ReimbursementRequest extends BaseModel {
  static tableName = 'reimbursement_requests';

  org_id!: string;
  user_id!: string;
  manager_id?: string | null;
  request_date!: string;
  type!: ReimbursementType;
  amount!: number | string;
  reason!: string;
  attachment_url?: string | null;
  status!: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  payment_status?: ReimbursementPaymentStatus | null;
  paid_at?: string | null;
  paid_by_user_id?: string | null;
  approver_comment?: string | null;
  cancelled_at?: string | Date | null;
  cancelled_by?: string | null;
  updated_by?: string | null;
  manager_status?: 'PENDING' | 'APPROVED' | 'REJECTED';
  hr_status?: 'PENDING' | 'APPROVED' | 'REJECTED';
  hr_id?: string | null;
  manager_action_at?: string | null;
  hr_action_at?: string | null;

  user?: User;
  manager?: User;
  hr?: User;

  static get relationMappings() {
    const { Organization } = require('./Organization');
    const { User } = require('./User');

    return {
      organization: {
        relation: Model.BelongsToOneRelation,
        modelClass: Organization,
        join: {
          from: 'reimbursement_requests.org_id',
          to: 'organizations.id',
        },
      },
      user: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'reimbursement_requests.user_id',
          to: 'users.id',
        },
      },
      manager: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'reimbursement_requests.manager_id',
          to: 'users.id',
        },
      },
      hr: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'reimbursement_requests.hr_id',
          to: 'users.id',
        },
      },
    };
  }
}
