import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class BankDetail extends BaseModel {
  static tableName = 'bank_details';

  user_id!: string;
  account_holder_name?: string;
  account_number?: string;
  ifsc_code?: string;
  bank_name?: string;
  branch_name?: string;
  account_type!: string;
  bank_proof_url!: string;
  bank_proof_key!: string;
  verification_status?: 'PENDING' | 'IN_PROGRESS' | 'VERIFIED' | 'FAILED';
  verification_failure_reason?: string;
  verification_checked_at?: string;
  verification_provider?: string;
  verification_meta?: unknown;

  static get relationMappings() {
    const { User } = require('./User');

    return {
      user: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'bank_details.user_id',
          to: 'users.id',
        },
      },
    };
  }
}
