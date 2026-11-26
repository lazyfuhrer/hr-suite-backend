import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('departments', (table) => {
    table.specificType('location_ids', 'uuid[]').nullable();
    table.specificType('work_shift_ids', 'uuid[]').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('departments', (table) => {
    table.dropColumn('work_shift_ids');
    table.dropColumn('location_ids');
  });
}
