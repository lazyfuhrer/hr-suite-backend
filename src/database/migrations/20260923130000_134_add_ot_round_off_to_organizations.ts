import type { Knex } from 'knex';

const TABLE = 'organizations';
const ENABLED_COLUMN = 'ot_round_off_enabled';
const MINS_COLUMN = 'ot_round_off_mins';

export async function up(knex: Knex): Promise<void> {
  const hasEnabled = await knex.schema.hasColumn(TABLE, ENABLED_COLUMN);
  if (!hasEnabled) {
    await knex.schema.alterTable(TABLE, (table) => {
      table.boolean(ENABLED_COLUMN).notNullable().defaultTo(false);
    });
  }

  const hasMins = await knex.schema.hasColumn(TABLE, MINS_COLUMN);
  if (!hasMins) {
    await knex.schema.alterTable(TABLE, (table) => {
      table.integer(MINS_COLUMN).notNullable().defaultTo(15);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasMins = await knex.schema.hasColumn(TABLE, MINS_COLUMN);
  if (hasMins) {
    await knex.schema.alterTable(TABLE, (table) => {
      table.dropColumn(MINS_COLUMN);
    });
  }

  const hasEnabled = await knex.schema.hasColumn(TABLE, ENABLED_COLUMN);
  if (hasEnabled) {
    await knex.schema.alterTable(TABLE, (table) => {
      table.dropColumn(ENABLED_COLUMN);
    });
  }
}
