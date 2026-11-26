import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('organizations', (table) => {
    table.timestamp('expires_at', { useTz: true }).nullable();
  });

  await knex.raw(`
    UPDATE organizations
    SET expires_at = created_at + interval '6 months'
    WHERE expires_at IS NULL
  `);

  await knex.schema.alterTable('organizations', (table) => {
    table.timestamp('expires_at', { useTz: true }).notNullable().alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('organizations', (table) => {
    table.dropColumn('expires_at');
  });
}
