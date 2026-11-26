import type { Knex } from 'knex';

const TABLES = [
  'leave_requests',
  'attendance_correction_requests',
  'wfh_requests',
  'reimbursement_requests',
] as const;

export async function up(knex: Knex): Promise<void> {
  for (const tableName of TABLES) {
    await knex.schema.alterTable(tableName, (table) => {
      table.uuid('updated_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const tableName of TABLES) {
    await knex.schema.alterTable(tableName, (table) => {
      table.dropColumn('updated_by');
    });
  }
}
