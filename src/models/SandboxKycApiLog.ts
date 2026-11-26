import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class SandboxKycApiLog extends BaseModel {
  static tableName = 'sandbox_kyc_api_logs';

  org_id!: string | null;
  user_id!: string;
  api_kind!: string;
  http_status!: number;
  response_body!: Record<string, unknown>;

  static get relationMappings() {
    const { Organization } = require('./Organization');
    const { User } = require('./User');

    return {
      organization: {
        relation: Model.BelongsToOneRelation,
        modelClass: Organization,
        join: {
          from: 'sandbox_kyc_api_logs.org_id',
          to: 'organizations.id',
        },
      },
      user: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'sandbox_kyc_api_logs.user_id',
          to: 'users.id',
        },
      },
    };
  }
}
