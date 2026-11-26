import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('attendance_correction_requests', (table) => {
    // Regularization metadata (employee submission)
    table
      .enu('wrong_punch_type', ['MISSING_IN', 'MISSING_OUT', 'WRONG_IN', 'WRONG_OUT'])
      .nullable();
    // Stores the user-provided time string (HH:MM) from UI for traceability
    table.string('corrected_time', 5).nullable();
    table.text('attachment_url').nullable();

    // Multi-stage approvals (Manager -> HR). Keep existing `status` for overall result.
    table
      .enu('manager_status', ['PENDING', 'APPROVED', 'REJECTED'])
      .notNullable()
      .defaultTo('PENDING');
    table.enu('hr_status', ['PENDING', 'APPROVED', 'REJECTED']).notNullable().defaultTo('PENDING');

    table.uuid('manager_id').references('id').inTable('users').onDelete('SET NULL');
    table.uuid('hr_id').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('manager_action_at', { useTz: true }).nullable();
    table.timestamp('hr_action_at', { useTz: true }).nullable();

    // Optional approver comment (e.g. rejection reason)
    table.text('approver_comment').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('attendance_correction_requests', (table) => {
    table.dropColumn('wrong_punch_type');
    table.dropColumn('corrected_time');
    table.dropColumn('attachment_url');
    table.dropColumn('manager_status');
    table.dropColumn('hr_status');
    table.dropColumn('manager_id');
    table.dropColumn('hr_id');
    table.dropColumn('manager_action_at');
    table.dropColumn('hr_action_at');
    table.dropColumn('approver_comment');
  });
}
