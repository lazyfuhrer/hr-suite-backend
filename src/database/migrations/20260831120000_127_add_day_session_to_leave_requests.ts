import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('leave_requests', (table) => {
    table.text('day_session').notNullable().defaultTo('FULL');
  });

  await knex.raw(`
    ALTER TABLE leave_requests
    ADD CONSTRAINT leave_requests_day_session_check
    CHECK (day_session IN ('FULL', 'FIRST_HALF', 'SECOND_HALF'));
  `);

  // total_days must hold 0.5 for half-day requests; it was created as an integer.
  // double precision (not numeric) so the pg driver keeps returning a JS number.
  await knex.raw(`
    ALTER TABLE leave_requests
    ALTER COLUMN total_days TYPE double precision;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE leave_requests
    ALTER COLUMN total_days TYPE integer USING ROUND(total_days)::integer;
  `);

  await knex.raw(`
    ALTER TABLE leave_requests
    DROP CONSTRAINT IF EXISTS leave_requests_day_session_check;
  `);

  await knex.schema.alterTable('leave_requests', (table) => {
    table.dropColumn('day_session');
  });
}
