import { Knex } from 'knex';

const TABLE = 'salary_structures';

export async function up(knex: Knex): Promise<void> {
  const hasColumn = await knex.schema.hasColumn(TABLE, 'employer_total_contributions');
  if (hasColumn) return;

  await knex.schema.alterTable(TABLE, (table) => {
    table.decimal('employer_total_contributions', 12, 2).notNullable().defaultTo(0);
  });
}

export async function down(knex: Knex): Promise<void> {
  const hasColumn = await knex.schema.hasColumn(TABLE, 'employer_total_contributions');
  if (!hasColumn) return;

  await knex.schema.alterTable(TABLE, (table) => {
    table.dropColumn('employer_total_contributions');
  });
}
