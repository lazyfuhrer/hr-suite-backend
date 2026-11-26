import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('org_notification_settings', (table) => {
    table.boolean('enabled_location_request_notifications').notNullable().defaultTo(false);
    table.integer('location_request_interval_hours').notNullable().defaultTo(4);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('org_notification_settings', (table) => {
    table.dropColumn('enabled_location_request_notifications');
    table.dropColumn('location_request_interval_hours');
  });
}
