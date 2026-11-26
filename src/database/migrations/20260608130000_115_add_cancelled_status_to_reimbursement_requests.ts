import type { Knex } from 'knex';

const REIMBURSEMENT_STATUS_CHECK = 'reimbursement_requests_status_check';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.raw(
    `ALTER TABLE "reimbursement_requests" DROP CONSTRAINT IF EXISTS "${REIMBURSEMENT_STATUS_CHECK}"`,
  );
  await knex.schema.raw(
    `ALTER TABLE "reimbursement_requests" ADD CONSTRAINT "${REIMBURSEMENT_STATUS_CHECK}" CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED'))`,
  );

  await knex.schema.alterTable('reimbursement_requests', (table) => {
    table.timestamp('cancelled_at', { useTz: true }).nullable();
    table.uuid('cancelled_by').nullable().references('id').inTable('users').onDelete('SET NULL');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex('reimbursement_requests').where('status', 'CANCELLED').delete();

  await knex.schema.alterTable('reimbursement_requests', (table) => {
    table.dropColumn('cancelled_by');
    table.dropColumn('cancelled_at');
  });
  await knex.schema.raw(
    `ALTER TABLE "reimbursement_requests" DROP CONSTRAINT IF EXISTS "${REIMBURSEMENT_STATUS_CHECK}"`,
  );
  await knex.schema.raw(
    `ALTER TABLE "reimbursement_requests" ADD CONSTRAINT "${REIMBURSEMENT_STATUS_CHECK}" CHECK (status IN ('PENDING','APPROVED','REJECTED'))`,
  );
}
