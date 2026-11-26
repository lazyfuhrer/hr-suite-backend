import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('organization_documents', (table) => {
    table
      .enu('verification_status', ['PENDING', 'VERIFIED', 'REJECTED'])
      .notNullable()
      .defaultTo('PENDING');
    table.text('rejection_reason');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('organization_documents', (table) => {
    table.dropColumn('rejection_reason');
    table.dropColumn('verification_status');
  });
}
