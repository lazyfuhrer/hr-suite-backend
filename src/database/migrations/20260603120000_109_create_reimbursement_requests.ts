import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('reimbursement_requests', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table
      .uuid('org_id')
      .notNullable()
      .references('id')
      .inTable('organizations')
      .onDelete('CASCADE');
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.uuid('manager_id').references('id').inTable('users').onDelete('SET NULL');
    table.date('request_date').notNullable();
    table.decimal('amount', 12, 2).notNullable();
    table.text('reason').notNullable();
    table.text('attachment_url').nullable();
    table.enu('status', ['PENDING', 'APPROVED', 'REJECTED']).notNullable().defaultTo('PENDING');
    table.text('approver_comment').nullable();
    table
      .enu('manager_status', ['PENDING', 'APPROVED', 'REJECTED'])
      .notNullable()
      .defaultTo('PENDING');
    table.enu('hr_status', ['PENDING', 'APPROVED', 'REJECTED']).notNullable().defaultTo('PENDING');
    table.uuid('hr_id').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('manager_action_at', { useTz: true }).nullable();
    table.timestamp('hr_action_at', { useTz: true }).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.alterTable('reimbursement_requests', (table) => {
    table.index(['org_id', 'status', 'created_at']);
    table.index(['org_id', 'user_id', 'request_date']);
  });

  await knex.raw(`
    CREATE UNIQUE INDEX reimbursement_requests_one_pending_per_day
    ON reimbursement_requests (org_id, user_id, request_date)
    WHERE status = 'PENDING'
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS reimbursement_requests_one_pending_per_day');
  await knex.schema.dropTableIfExists('reimbursement_requests');
}
