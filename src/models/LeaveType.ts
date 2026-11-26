import { Model } from 'objection';

export class LeaveType extends Model {
  static tableName = 'leave_types';

  id!: string;
  org_id!: string;
  name!: string;
  annual_quota!: number;

  static get relationMappings() {
    const { Organization } = require('./Organization');
    const { LeaveRequest } = require('./LeaveRequest');

    return {
      organization: {
        relation: Model.BelongsToOneRelation,
        modelClass: Organization,
        join: {
          from: 'leave_types.org_id',
          to: 'organizations.id',
        },
      },
      leaveRequests: {
        relation: Model.HasManyRelation,
        modelClass: LeaveRequest,
        join: {
          from: 'leave_types.id',
          to: 'leave_requests.leave_type_id',
        },
      },
    };
  }
}
