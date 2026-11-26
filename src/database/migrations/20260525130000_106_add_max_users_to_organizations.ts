import type { Knex } from 'knex';

const DEFAULT_MAX_USERS = 50;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('organizations', (table) => {
    table.integer('max_users').notNullable().defaultTo(DEFAULT_MAX_USERS);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('organizations', (table) => {
    table.dropColumn('max_users');
  });
}
