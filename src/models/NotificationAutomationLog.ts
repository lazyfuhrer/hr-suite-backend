import { BaseModel } from './BaseModel';

export class NotificationAutomationLog extends BaseModel {
  static tableName = 'notification_automation_logs';

  org_id!: string;
  subject_user_id!: string;
  rule_key!: string;
  event_key!: string;
  status!: 'PENDING' | 'SENT' | 'READ' | 'DISMISSED';
  trigger_time!: string;
  sent_at?: string | null;
  audience_count!: number;
  success_count!: number;
  failure_count!: number;
  meta!: Record<string, unknown>;
}
