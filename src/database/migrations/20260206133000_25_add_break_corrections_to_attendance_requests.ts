import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('attendance_correction_requests', (table) => {
    table.jsonb('break_corrections');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('attendance_correction_requests', (table) => {
    table.dropColumn('break_corrections');
  });
}
