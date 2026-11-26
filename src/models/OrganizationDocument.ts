const { Model } = require('objection');

export class OrganizationDocument extends Model {
  static get tableName() {
    return 'organization_documents';
  }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['org_id', 'doc_category', 'doc_type', 'file_url'],

      properties: {
        id: { type: 'string', format: 'uuid' },
        org_id: { type: 'string', format: 'uuid' },
        doc_category: {
          type: 'string',
          enum: ['LEGAL', 'COMPLIANCE', 'FINANCIAL', 'OPERATIONAL', 'OTHER'],
        },
        doc_type: { type: 'string', minLength: 1, maxLength: 255 },
        file_url: { type: 'string', minLength: 1 },
        file_key: { type: 'string', minLength: 1 },
        verification_status: {
          type: 'string',
          enum: ['PENDING', 'VERIFIED', 'REJECTED'],
        },
        rejection_reason: { type: 'string' },
      },
    };
  }

  static get relationMappings() {
    const Organization = require('./Organization');
    return {
      organization: {
        relation: Model.BelongsToOneRelation,
        modelClass: Organization,
        join: {
          from: 'organization_documents.org_id',
          to: 'organizations.id',
        },
      },
    };
  }
}
