import { Model } from 'objection';

export abstract class BaseModel extends Model {
  readonly id!: string;
  created_at!: Date;
  updated_at!: Date;

  $beforeInsert(): void {
    const now = new Date();
    this.created_at = now;
    this.updated_at = now;
  }

  $beforeUpdate(): void {
    this.updated_at = new Date();
  }
}
