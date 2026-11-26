import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable('user_exits');
  if (hasTable) {
    return;
  }

  await knex.schema.createTable('user_exits', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table
      .uuid('org_id')
      .notNullable()
      .references('id')
      .inTable('organizations')
      .onDelete('CASCADE');
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table
      .enu('exit_type', ['RESIGNATION', 'TERMINATION', 'RETIREMENT', 'END_OF_CONTRACT', 'OTHER'])
      .notNullable();
    table.text('exit_reason').nullable();
    table.date('notice_start_date').nullable();
    table.date('last_working_day').notNullable();
    table.timestamp('exited_at', { useTz: true }).nullable();
    table.enu('status', ['ON_NOTICE', 'COMPLETED', 'CANCELLED']).notNullable();
    table.uuid('initiated_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    table.uuid('confirmed_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    table.uuid('cancelled_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('initiated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('confirmed_at', { useTz: true }).nullable();
    table.timestamp('cancelled_at', { useTz: true }).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['org_id', 'user_id'], 'idx_user_exits_org_user');
    table.index(['org_id', 'exited_at'], 'idx_user_exits_org_exited_at');
  });

  await knex.raw(`
    CREATE INDEX idx_user_exits_active_lookup
    ON user_exits (org_id, user_id)
    WHERE status IN ('ON_NOTICE', 'COMPLETED')
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS idx_user_exits_active_lookup');
  await knex.schema.dropTableIfExists('user_exits');
}
