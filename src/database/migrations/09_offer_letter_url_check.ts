import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user_onboardings', (table) => {
    table.check(
      "onboarding_status IS DISTINCT FROM 'COMPLETED' OR offer_letter_url IS NOT NULL",
      [],
      'user_onboardings_offer_letter_url_required',
    );
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user_onboardings', (table) => {
    table.dropChecks(['user_onboardings_offer_letter_url_required']);
  });
}
