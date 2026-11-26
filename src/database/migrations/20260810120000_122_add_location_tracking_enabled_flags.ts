import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const hasDeptColumn = await knex.schema.hasColumn('departments', 'location_tracking_enabled');
  if (!hasDeptColumn) {
    await knex.schema.alterTable('departments', (table) => {
      table.boolean('location_tracking_enabled').notNullable().defaultTo(false);
    });
  }

  const hasUserColumn = await knex.schema.hasColumn('users', 'location_tracking_enabled');
  if (!hasUserColumn) {
    await knex.schema.alterTable('users', (table) => {
      table.boolean('location_tracking_enabled').nullable().defaultTo(null);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasUserColumn = await knex.schema.hasColumn('users', 'location_tracking_enabled');
  if (hasUserColumn) {
    await knex.schema.alterTable('users', (table) => {
      table.dropColumn('location_tracking_enabled');
    });
  }

  const hasDeptColumn = await knex.schema.hasColumn('departments', 'location_tracking_enabled');
  if (hasDeptColumn) {
    await knex.schema.alterTable('departments', (table) => {
      table.dropColumn('location_tracking_enabled');
    });
  }
}
