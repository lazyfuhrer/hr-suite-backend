import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('attendance_logs', (table) => {
    table.decimal('punch_in_lat', 10, 8);
    table.decimal('punch_in_long', 11, 8);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('attendance_logs', (table) => {
    table.dropColumn('punch_in_long');
    table.dropColumn('punch_in_lat');
  });
}
