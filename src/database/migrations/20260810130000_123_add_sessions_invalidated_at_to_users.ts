import type { Knex } from 'knex';

const TABLE = 'users';
const COLUMN = 'sessions_invalidated_at';

export async function up(knex: Knex): Promise<void> {
  const hasColumn = await knex.schema.hasColumn(TABLE, COLUMN);
  if (hasColumn) return;

  await knex.schema.alterTable(TABLE, (table) => {
    table.timestamp(COLUMN, { useTz: true }).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  const hasColumn = await knex.schema.hasColumn(TABLE, COLUMN);
  if (!hasColumn) return;

  await knex.schema.alterTable(TABLE, (table) => {
    table.dropColumn(COLUMN);
  });
}
