import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class UserFaceEmbedding extends BaseModel {
  static tableName = 'user_face_embeddings';

  org_id!: string;
  user_id!: string;
  provider!: string;
  rekognition_collection_id!: string;
  rekognition_face_id!: string;

  static get relationMappings() {
    const { Organization } = require('./Organization');
    const { User } = require('./User');

    return {
      organization: {
        relation: Model.BelongsToOneRelation,
        modelClass: Organization,
        join: {
          from: 'user_face_embeddings.org_id',
          to: 'organizations.id',
        },
      },
      user: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'user_face_embeddings.user_id',
          to: 'users.id',
        },
      },
    };
  }
}
