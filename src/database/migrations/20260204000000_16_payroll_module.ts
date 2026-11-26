import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // User payroll details (PF, tax info, etc. - editable by employee)
  await knex.schema.createTable('user_payroll_details', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table
      .uuid('user_id')
      .notNullable()
      .unique()
      .references('id')
      .inTable('users')
      .onDelete('CASCADE');
    table.string('pan_number').nullable();
    table.string('aadhaar_number').nullable();
    table.string('pf_number').nullable();
    table.string('uan_number').nullable(); // Universal Account Number for EPF
    table.string('esi_number').nullable(); // Employee State Insurance
    table.string('tax_saving_investments').nullable(); // JSON string for various tax saving investments
    table.decimal('declared_tax', 12, 2).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // Salary components (reusable components like Basic, HRA, DA, etc.)
  await knex.schema.createTable('salary_components', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table
      .uuid('org_id')
      .notNullable()
      .references('id')
      .inTable('organizations')
      .onDelete('CASCADE');
    table.string('name').notNullable(); // e.g., "Basic", "HRA", "DA", "Transport Allowance"
    table.string('code').notNullable(); // e.g., "BASIC", "HRA", "DA"
    table
      .enu('type', ['EARNING', 'DEDUCTION', 'ALLOWANCE', 'BONUS', 'OVERTIME', 'INCENTIVE'])
      .notNullable();
    table.boolean('is_taxable').notNullable().defaultTo(true);
    table.boolean('is_pf_applicable').notNullable().defaultTo(false);
    table.boolean('is_esi_applicable').notNullable().defaultTo(false);
    table.integer('display_order').notNullable().defaultTo(0);
    table.boolean('is_active').notNullable().defaultTo(true);
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('deleted_at', { useTz: true }).nullable();
    table.unique(['org_id', 'code']);
  });

  // Salary structures (assigned to users, defines their salary breakdown)
  await knex.schema.createTable('salary_structures', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table
      .uuid('org_id')
      .notNullable()
      .references('id')
      .inTable('organizations')
      .onDelete('CASCADE');
    table.date('effective_from').notNullable();
    table.date('effective_to').nullable();
    table.decimal('gross_salary', 12, 2).notNullable();
    table.decimal('net_salary', 12, 2).notNullable();
    table.jsonb('component_breakdown').notNullable(); // { component_id: amount, ... }
    table.text('notes').nullable();
    table.boolean('is_active').notNullable().defaultTo(true);
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('deleted_at', { useTz: true }).nullable();
  });

  // Payroll records (monthly payroll records)
  await knex.schema.createTable('payroll_records', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table
      .uuid('org_id')
      .notNullable()
      .references('id')
      .inTable('organizations')
      .onDelete('CASCADE');
    table.integer('payroll_month').notNullable(); // 1-12
    table.integer('payroll_year').notNullable();
    table.uuid('salary_structure_id').nullable().references('id').inTable('salary_structures');
    table.decimal('gross_salary', 12, 2).notNullable();
    table.decimal('total_earnings', 12, 2).notNullable();
    table.decimal('total_deductions', 12, 2).notNullable();
    table.decimal('net_salary', 12, 2).notNullable();
    table.decimal('pf_contribution', 12, 2).nullable();
    table.decimal('esi_contribution', 12, 2).nullable();
    table.decimal('income_tax', 12, 2).nullable();
    table.decimal('professional_tax', 12, 2).nullable();
    table.decimal('overtime_amount', 12, 2).nullable().defaultTo(0);
    table.decimal('incentive_amount', 12, 2).nullable().defaultTo(0);
    table.decimal('bonus_amount', 12, 2).nullable().defaultTo(0);
    table.decimal('allowance_amount', 12, 2).nullable().defaultTo(0);
    table.jsonb('component_breakdown').notNullable(); // Detailed breakdown
    table.text('payslip_pdf_url').nullable();
    table
      .enu('status', ['DRAFT', 'PROCESSED', 'PAID', 'CANCELLED'])
      .notNullable()
      .defaultTo('DRAFT');
    table.text('notes').nullable();
    table.timestamp('processed_at', { useTz: true }).nullable();
    table.timestamp('paid_at', { useTz: true }).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(['user_id', 'payroll_month', 'payroll_year']);
  });

  // Payroll uploads (for admin to upload Excel/PDF files)
  await knex.schema.createTable('payroll_uploads', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table
      .uuid('org_id')
      .notNullable()
      .references('id')
      .inTable('organizations')
      .onDelete('CASCADE');
    table.uuid('uploaded_by').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.integer('payroll_month').notNullable();
    table.integer('payroll_year').notNullable();
    table.string('file_type').notNullable(); // 'EXCEL' or 'PDF'
    table.text('file_url').notNullable();
    table.string('file_name').notNullable();
    table.integer('total_records').nullable();
    table.integer('processed_records').nullable().defaultTo(0);
    table.integer('failed_records').nullable().defaultTo(0);
    table
      .enu('status', ['UPLOADED', 'PROCESSING', 'COMPLETED', 'FAILED', 'PARTIALLY_PROCESSED'])
      .notNullable()
      .defaultTo('UPLOADED');
    table.jsonb('processing_errors').nullable(); // Array of errors
    table.text('notes').nullable();
    table.timestamp('processed_at', { useTz: true }).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('payroll_uploads');
  await knex.schema.dropTableIfExists('payroll_records');
  await knex.schema.dropTableIfExists('salary_structures');
  await knex.schema.dropTableIfExists('salary_components');
  await knex.schema.dropTableIfExists('user_payroll_details');
}
