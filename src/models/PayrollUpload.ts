import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class PayrollUpload extends BaseModel {
  static tableName = 'payroll_uploads';

  org_id!: string;
  uploaded_by!: string;
  payroll_month!: number;
  payroll_year!: number;
  file_type!: 'EXCEL' | 'PDF';
  file_url!: string;
  file_name!: string;
  total_records?: number;
  processed_records?: number;
  failed_records?: number;
  status!: 'UPLOADED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'PARTIALLY_PROCESSED';
  processing_errors?: Array<{ row?: number; error: string }>;
  notes?: string;
  processed_at?: Date;

  static get relationMappings() {
    const { Organization } = require('./Organization');
    const { User } = require('./User');

    return {
      organization: {
        relation: Model.BelongsToOneRelation,
        modelClass: Organization,
        join: {
          from: 'payroll_uploads.org_id',
          to: 'organizations.id',
        },
      },
      uploadedBy: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'payroll_uploads.uploaded_by',
          to: 'users.id',
        },
      },
    };
  }
}
