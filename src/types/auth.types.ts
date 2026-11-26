export interface TokenPayload {
  id: string;
  email?: string;
  org_id?: string;
  org_ids?: string[];
  role: string;
  type: 'platform' | 'tenant' | 'tenant_select' | 'password_reset';
  reset_token_id?: string;
  /** Seconds since epoch; set automatically by jwt.sign */
  iat?: number;
  exp?: number;
}
