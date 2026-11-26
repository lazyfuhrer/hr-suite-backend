import { Model } from 'objection';

import { BaseModel } from './BaseModel';

export class UserOnboarding extends BaseModel {
  static tableName = 'user_onboardings';

  user_id!: string;
  asset_device_pref?: string;
  device_serial_number?: string;
  asset_agreement_accepted!: boolean;
  policy_acknowledged!: boolean;
  offer_letter_signed!: boolean;
  offer_letter_url?: string;
  onboarding_status?: string;
  completed_at?: string;
  kyc_status?: string;
  kyc_failure_reason?: string;
  kyc_checked_at?: string;
  kyc_provider?: string;
  kyc_gating_exempt?: boolean;

  static get relationMappings() {
    const { User } = require('./User');

    return {
      user: {
        relation: Model.BelongsToOneRelation,
        modelClass: User,
        join: {
          from: 'user_onboardings.user_id',
          to: 'users.id',
        },
      },
    };
  }
}
