import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('attendance_correction_requests', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table
      .bigInteger('attendance_log_id')
      .references('id')
      .inTable('attendance_logs')
      .onDelete('SET NULL');
    table.date('request_date').notNullable();
    table.timestamp('requested_clock_in', { useTz: true }).notNullable();
    table.timestamp('requested_clock_out', { useTz: true }).notNullable();
    table.text('reason');
    table.enu('status', ['PENDING', 'APPROVED', 'REJECTED']).notNullable().defaultTo('PENDING');
    table.uuid('approver_id').references('id').inTable('users');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('attendance_correction_requests');
}
