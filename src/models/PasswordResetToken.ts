import { BaseModel } from './BaseModel';

export class PasswordResetToken extends BaseModel {
  static tableName = 'password_reset_tokens';

  user_id!: string;
  otp_code!: string;
  expires_at!: string;
  consumed_at?: string | null;
}
