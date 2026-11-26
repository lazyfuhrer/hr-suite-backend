import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user_onboardings', (table) => {
    table.text('offer_letter_url');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user_onboardings', (table) => {
    table.dropColumn('offer_letter_url');
  });
}
