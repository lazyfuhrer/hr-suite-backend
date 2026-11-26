import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS reimbursement_requests_one_pending_per_day');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE UNIQUE INDEX reimbursement_requests_one_pending_per_day
    ON reimbursement_requests (org_id, user_id, request_date)
    WHERE status = 'PENDING'
  `);
}
