import type { Knex } from 'knex';

const TABLE = 'attendance_correction_requests';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable(TABLE, (table) => {
    // Allow requested_clock_in/out to be nullable so that regularization requests
    // can be created even when we cannot yet derive full clock-in/out times.
    table.timestamp('requested_clock_in', { useTz: true }).nullable().alter();
    table.timestamp('requested_clock_out', { useTz: true }).nullable().alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable(TABLE, (table) => {
    // Restore NOT NULL constraint (will fail if there are rows with null values).
    table.timestamp('requested_clock_in', { useTz: true }).notNullable().alter();
    table.timestamp('requested_clock_out', { useTz: true }).notNullable().alter();
  });
}
