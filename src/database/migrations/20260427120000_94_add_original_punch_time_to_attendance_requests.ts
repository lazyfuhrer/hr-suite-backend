import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('attendance_correction_requests', (table) => {
    table.timestamp('original_punch_time', { useTz: true }).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('attendance_correction_requests', (table) => {
    table.dropColumn('original_punch_time');
  });
}
