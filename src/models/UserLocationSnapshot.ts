import { BaseModel } from './BaseModel';

export class UserLocationSnapshot extends BaseModel {
  static tableName = 'user_location_snapshots';

  org_id!: string;
  user_id!: string;
  latitude!: string;
  longitude!: string;
  captured_at!: Date;
  prompt_slot_key!: string | null;
  source!: string;
}
