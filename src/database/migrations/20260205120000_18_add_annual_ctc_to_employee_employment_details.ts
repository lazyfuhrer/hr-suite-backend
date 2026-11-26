import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const hasColumn = await knex.schema.hasColumn('employee_employment_details', 'annual_ctc');
  if (!hasColumn) {
    await knex.schema.alterTable('employee_employment_details', (table) => {
      table.decimal('annual_ctc', 12, 2).nullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasColumn = await knex.schema.hasColumn('employee_employment_details', 'annual_ctc');
  if (hasColumn) {
    await knex.schema.alterTable('employee_employment_details', (table) => {
      table.dropColumn('annual_ctc');
    });
  }
}
