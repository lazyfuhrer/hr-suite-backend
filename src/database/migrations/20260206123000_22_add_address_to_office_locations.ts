import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('office_locations', (table) => {
    table.string('address');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('office_locations', (table) => {
    table.dropColumn('address');
  });
}
