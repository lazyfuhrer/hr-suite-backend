import { BaseModel } from './BaseModel';

export type RefreshTokenSubjectType = 'tenant' | 'platform';

export class RefreshToken extends BaseModel {
  static tableName = 'refresh_tokens';

  token_hash!: string;
  subject_type!: RefreshTokenSubjectType;
  subject_id!: string;
  org_id?: string | null;
  role!: string;
  expires_at!: string;
  revoked_at?: string | null;
  replaced_by?: string | null;
}
