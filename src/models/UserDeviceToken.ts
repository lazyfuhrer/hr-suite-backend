import { BaseModel } from './BaseModel';

export type DevicePlatform = 'apns' | 'gcm' | 'web';

export class UserDeviceToken extends BaseModel {
  static tableName = 'user_device_tokens';

  user_id!: string;
  org_id?: string | null;
  token!: string;
  platform!: DevicePlatform | string;
  device_id?: string | null;
  enabled!: boolean;
  last_seen_at?: Date | string | null;
}
