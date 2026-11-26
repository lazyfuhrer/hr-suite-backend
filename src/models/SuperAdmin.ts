import { BaseModel } from './BaseModel';

export class SuperAdmin extends BaseModel {
  static tableName = 'super_admins';

  email!: string;
  password_hash!: string;
  full_name?: string;
}
