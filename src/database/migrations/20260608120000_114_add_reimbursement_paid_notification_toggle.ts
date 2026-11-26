import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('org_notification_settings', (table) => {
    table.boolean('enabled_reimbursement_paid_notifications').notNullable().defaultTo(true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('org_notification_settings', (table) => {
    table.dropColumn('enabled_reimbursement_paid_notifications');
  });
}
