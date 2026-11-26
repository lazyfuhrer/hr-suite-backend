import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bank_details', (table) => {
    table.text('bank_proof_url').nullable();
    table.text('bank_proof_key').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bank_details', (table) => {
    table.dropColumn('bank_proof_url');
    table.dropColumn('bank_proof_key');
  });
}
