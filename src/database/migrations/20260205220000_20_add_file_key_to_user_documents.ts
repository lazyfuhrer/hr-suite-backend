import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user_documents', (table) => {
    table.string('file_key').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user_documents', (table) => {
    table.dropColumn('file_key');
  });
}
