import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('departments', (table) => {
    // Store working days as an array of uppercase weekday strings, e.g.
    // ["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY"].
    table.specificType('working_days', 'text[]');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('departments', (table) => {
    table.dropColumn('working_days');
  });
}
