import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('leave_requests', (table) => {
    table.integer('total_days').nullable();
    table.text('attachment_url').nullable();
    table.text('approver_comment').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('leave_requests', (table) => {
    table.dropColumn('total_days');
    table.dropColumn('attachment_url');
    table.dropColumn('approver_comment');
  });
}
