import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('org_notification_settings', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table
      .uuid('org_id')
      .notNullable()
      .references('id')
      .inTable('organizations')
      .onDelete('CASCADE')
      .unique();

    table.boolean('enabled_before_shift_start').notNullable().defaultTo(true);
    table.boolean('enabled_after_shift_start_no_checkin').notNullable().defaultTo(true);
    table.boolean('enabled_before_shift_end').notNullable().defaultTo(true);
    table.boolean('enabled_after_shift_end_no_checkout').notNullable().defaultTo(true);
    table.boolean('enabled_before_break_start').notNullable().defaultTo(true);
    table.boolean('enabled_before_break_end').notNullable().defaultTo(true);
    table.boolean('enabled_break_exceeded').notNullable().defaultTo(true);

    table.integer('before_shift_start_mins').notNullable().defaultTo(15);
    table.integer('after_shift_start_no_checkin_mins').notNullable().defaultTo(30);
    table.integer('before_shift_end_mins').notNullable().defaultTo(15);
    table.integer('after_shift_end_no_checkout_mins').notNullable().defaultTo(30);
    table.integer('before_break_start_mins').notNullable().defaultTo(5);
    table.integer('before_break_end_mins').notNullable().defaultTo(5);
    table.integer('break_exceeded_mins').notNullable().defaultTo(20);

    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('notification_automation_logs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table
      .uuid('org_id')
      .notNullable()
      .references('id')
      .inTable('organizations')
      .onDelete('CASCADE');
    table
      .uuid('subject_user_id')
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('CASCADE');
    table.string('rule_key', 64).notNullable();
    table.string('event_key', 256).notNullable().unique();
    table
      .enu('status', ['PENDING', 'SENT', 'READ', 'DISMISSED'])
      .notNullable()
      .defaultTo('PENDING');
    table.timestamp('trigger_time', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('sent_at', { useTz: true });
    table.integer('audience_count').notNullable().defaultTo(0);
    table.integer('success_count').notNullable().defaultTo(0);
    table.integer('failure_count').notNullable().defaultTo(0);
    table.jsonb('meta').notNullable().defaultTo('{}');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('notification_automation_logs');
  await knex.schema.dropTableIfExists('org_notification_settings');
}
