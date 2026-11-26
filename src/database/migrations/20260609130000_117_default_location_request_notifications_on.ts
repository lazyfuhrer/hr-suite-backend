import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex('org_notification_settings')
    .where('enabled_location_request_notifications', false)
    .update({ enabled_location_request_notifications: true });

  await knex.schema.alterTable('org_notification_settings', (table) => {
    table.boolean('enabled_location_request_notifications').notNullable().defaultTo(true).alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('org_notification_settings', (table) => {
    table.boolean('enabled_location_request_notifications').notNullable().defaultTo(false).alter();
  });
}
