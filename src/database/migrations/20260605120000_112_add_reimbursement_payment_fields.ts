import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('reimbursement_requests', (table) => {
    table.enu('payment_status', ['UNPAID', 'PAID']).nullable();
    table.timestamp('paid_at', { useTz: true }).nullable();
    table.uuid('paid_by_user_id').references('id').inTable('users').onDelete('SET NULL');
  });

  await knex('reimbursement_requests')
    .where('status', 'APPROVED')
    .update({ payment_status: 'UNPAID' });

  await knex.schema.alterTable('reimbursement_requests', (table) => {
    table.index(['org_id', 'user_id', 'payment_status']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('reimbursement_requests', (table) => {
    table.dropIndex(['org_id', 'user_id', 'payment_status']);
    table.dropColumn('paid_by_user_id');
    table.dropColumn('paid_at');
    table.dropColumn('payment_status');
  });
}
