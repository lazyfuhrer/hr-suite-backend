import { BaseModel } from './BaseModel';

export type NotificationLogScope = 'user' | 'org' | 'tokens';

export type NotificationLogResponseRow = {
  tokenHash: string;
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
};

export class NotificationEventLog extends BaseModel {
  static tableName = 'notification_event_logs';

  static get jsonAttributes(): string[] {
    return ['data', 'target_user_ids', 'invalid_tokens', 'responses', 'error'];
  }

  org_id?: string | null;
  event!: string;
  scope!: NotificationLogScope;

  title?: string | null;
  body?: string | null;
  link?: string | null;
  data!: Record<string, unknown>;

  target_user_ids!: string[];
  target_org_id?: string | null;

  token_count!: number;
  success_count!: number;
  failure_count!: number;

  invalid_tokens!: string[];
  responses!: NotificationLogResponseRow[];
  error?: Record<string, unknown> | null;
}
