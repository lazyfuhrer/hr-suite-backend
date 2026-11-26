import type { Knex } from 'knex';

const TABLE = 'organizations';
const COLUMN = 'display_ot';

export async function up(knex: Knex): Promise<void> {
  const hasColumn = await knex.schema.hasColumn(TABLE, COLUMN);
  if (hasColumn) return;

  await knex.schema.alterTable(TABLE, (table) => {
    table.boolean(COLUMN).notNullable().defaultTo(true);
  });
}

export async function down(knex: Knex): Promise<void> {
  const hasColumn = await knex.schema.hasColumn(TABLE, COLUMN);
  if (!hasColumn) return;

  await knex.schema.alterTable(TABLE, (table) => {
    table.dropColumn(COLUMN);
  });
}
