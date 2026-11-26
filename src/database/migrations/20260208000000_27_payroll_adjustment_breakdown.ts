import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('payroll_records', (table) => {
    table.jsonb('adjustment_incentives').nullable().defaultTo(knex.raw(`'[]'::jsonb`));
    table.jsonb('adjustment_extra_deductions').nullable().defaultTo(knex.raw(`'[]'::jsonb`));
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('payroll_records', (table) => {
    table.dropColumn('adjustment_incentives');
    table.dropColumn('adjustment_extra_deductions');
  });
}
