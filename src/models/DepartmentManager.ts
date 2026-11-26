import { Model } from 'objection';

export class DepartmentManager extends Model {
  static tableName = 'department_managers';
  static idColumn = ['department_id', 'manager_id'];

  department_id!: string;
  manager_id!: string;
  created_at!: string;
}
