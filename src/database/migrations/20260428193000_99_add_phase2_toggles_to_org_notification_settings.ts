import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('org_notification_settings', (table) => {
    table.boolean('enabled_birthday_notifications').notNullable().defaultTo(true);
    table.boolean('enabled_work_anniversary_notifications').notNullable().defaultTo(true);
    table.boolean('enabled_holiday_notifications').notNullable().defaultTo(true);
    table.boolean('enabled_leave_submitted_notifications').notNullable().defaultTo(true);
    table.boolean('enabled_leave_status_notifications').notNullable().defaultTo(true);
    table.boolean('enabled_occasion_self_notifications').notNullable().defaultTo(true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('org_notification_settings', (table) => {
    table.dropColumn('enabled_occasion_self_notifications');
    table.dropColumn('enabled_leave_status_notifications');
    table.dropColumn('enabled_leave_submitted_notifications');
    table.dropColumn('enabled_holiday_notifications');
    table.dropColumn('enabled_work_anniversary_notifications');
    table.dropColumn('enabled_birthday_notifications');
  });
}
