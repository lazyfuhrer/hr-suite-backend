import { BaseModel } from './BaseModel';

export class Holiday extends BaseModel {
  static tableName = 'holidays';

  admin_id!: string;
  org_id!: string;
  date!: string;
  title!: string;
}
