import { Knex } from 'knex';

const TABLE = 'salary_structures';
const COL = 'hike_percentage';

export async function up(knex: Knex): Promise<void> {
  const hasColumn = await knex.schema.hasColumn(TABLE, COL);
  if (hasColumn) return;

  await knex.schema.alterTable(TABLE, (table) => {
    table.decimal(COL, 6, 2).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  const hasColumn = await knex.schema.hasColumn(TABLE, COL);
  if (!hasColumn) return;

  await knex.schema.alterTable(TABLE, (table) => {
    table.dropColumn(COL);
  });
}
