import type { Knex } from 'knex';

const TABLE = 'payroll_records';

export async function up(knex: Knex): Promise<void> {
  const hasEsi = await knex.schema.hasColumn(TABLE, 'esi_contribution');
  const hasIncomeTax = await knex.schema.hasColumn(TABLE, 'income_tax');

  if (!hasEsi && !hasIncomeTax) return;

  await knex.schema.alterTable(TABLE, (table) => {
    if (hasEsi) table.dropColumn('esi_contribution');
    if (hasIncomeTax) table.dropColumn('income_tax');
  });
}

export async function down(knex: Knex): Promise<void> {
  const hasEsi = await knex.schema.hasColumn(TABLE, 'esi_contribution');
  const hasIncomeTax = await knex.schema.hasColumn(TABLE, 'income_tax');

  if (hasEsi && hasIncomeTax) return;

  await knex.schema.alterTable(TABLE, (table) => {
    if (!hasEsi) table.decimal('esi_contribution', 12, 2).nullable();
    if (!hasIncomeTax) table.decimal('income_tax', 12, 2).nullable();
  });
}
