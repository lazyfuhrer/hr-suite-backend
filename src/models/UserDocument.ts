import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class UserDocument extends BaseModel {
  static tableName = 'user_documents';

  user_id!: string;
  doc_category!: string;
  doc_type!: string;
  file_url!: string;
  file_key?: string | null;
  verification_status!: string;
  rejection_reason?: string;
  uploaded_by?: string | null;
  verification_meta?: unknown;

  static get relationMappings() {
    const { User } = require('./User');

    return {
      user: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'user_documents.user_id',
          to: 'users.id',
        },
      },
    };
  }
}
