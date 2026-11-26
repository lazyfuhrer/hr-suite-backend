import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('attendance_half_day_no_punch_penalties', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table
      .uuid('org_id')
      .notNullable()
      .references('id')
      .inTable('organizations')
      .onDelete('CASCADE');
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.date('penalty_date').notNullable();
    table
      .uuid('original_leave_request_id')
      .notNullable()
      .references('id')
      .inTable('leave_requests')
      .onDelete('CASCADE');
    table
      .uuid('supplemental_leave_request_id')
      .nullable()
      .references('id')
      .inTable('leave_requests')
      .onDelete('SET NULL');
    table.double('lop_days').notNullable().defaultTo(0);
    table.timestamp('processed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(['org_id', 'user_id', 'penalty_date'], 'uq_half_day_no_punch_penalty_user_date');
    table.index(['penalty_date'], 'idx_half_day_no_punch_penalty_date');
    table.index(['org_id', 'user_id'], 'idx_half_day_no_punch_penalty_org_user');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('attendance_half_day_no_punch_penalties');
}
