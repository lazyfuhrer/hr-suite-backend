import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('organizations', (table) => {
    table
      .integer('late_grace_period_mins')
      .notNullable()
      .defaultTo(15)
      .comment('Minutes after shift start still considered on-time (0-60)');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('organizations', (table) => {
    table.dropColumn('late_grace_period_mins');
  });
}
