import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('reimbursement_requests', (table) => {
    table.enu('type', ['TRAVEL', 'MEAL', 'MEDICAL', 'OTHER']).notNullable().defaultTo('OTHER');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('reimbursement_requests', (table) => {
    table.dropColumn('type');
  });
}
