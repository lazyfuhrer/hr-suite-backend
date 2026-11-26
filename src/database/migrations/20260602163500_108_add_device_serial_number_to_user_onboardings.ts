import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user_onboardings', (table) => {
    table.text('device_serial_number').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user_onboardings', (table) => {
    table.dropColumn('device_serial_number');
  });
}
