import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('work_shifts', (table) => {
    table.time('break_start_time').notNullable().defaultTo('13:00:00');
    table.time('break_end_time').notNullable().defaultTo('14:00:00');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('work_shifts', (table) => {
    table.dropColumn('break_end_time');
    table.dropColumn('break_start_time');
  });
}
