import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Allow employee_id to be null during onboarding; it will be set later via the employment API.
  await knex.schema.alterTable('users', (table) => {
    table.string('employee_id').nullable().alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  // Revert to previous behavior where employee_id was required.
  await knex.schema.alterTable('users', (table) => {
    table.string('employee_id').notNullable().alter();
  });
}
