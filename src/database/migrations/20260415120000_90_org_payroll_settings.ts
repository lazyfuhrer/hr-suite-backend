import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('org_payroll_settings', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table
      .uuid('org_id')
      .notNullable()
      .unique()
      .references('id')
      .inTable('organizations')
      .onDelete('CASCADE');

    // X = Basic % of annual CTC
    table.decimal('basic_pct', 8, 4).notNullable();

    // Y = HRA % of Basic
    table.decimal('hra_pct_of_basic', 8, 4).notNullable();

    // Z1 = Employer PF: percentage of Basic or fixed annual value
    table.enu('employer_pf_type', ['PERCENTAGE', 'FIXED']).notNullable();
    table.decimal('employer_pf_value', 12, 2).notNullable();

    // Z2 = Employee PF: percentage of Basic or fixed annual value
    table.enu('employee_pf_type', ['PERCENTAGE', 'FIXED']).notNullable();
    table.decimal('employee_pf_value', 12, 2).notNullable();

    // A = Professional Tax (fixed annual value)
    table.decimal('professional_tax_annual', 12, 2).notNullable();

    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('org_payroll_settings');
}
