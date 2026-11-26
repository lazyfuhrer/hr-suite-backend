import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('leave_requests', (table) => {
    // Multi-stage approvals (Manager -> HR). Keep existing `status` for overall result.
    table
      .enu('manager_status', ['PENDING', 'APPROVED', 'REJECTED'])
      .notNullable()
      .defaultTo('PENDING');
    table.enu('hr_status', ['PENDING', 'APPROVED', 'REJECTED']).notNullable().defaultTo('PENDING');

    table.uuid('hr_id').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('manager_action_at', { useTz: true }).nullable();
    table.timestamp('hr_action_at', { useTz: true }).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('leave_requests', (table) => {
    table.dropColumn('hr_action_at');
    table.dropColumn('manager_action_at');
    table.dropColumn('hr_id');
    table.dropColumn('hr_status');
    table.dropColumn('manager_status');
  });
}
