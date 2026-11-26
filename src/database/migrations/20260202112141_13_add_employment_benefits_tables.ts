import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Employment & compensation metadata for users (optional, 1:1)
  await knex.schema.createTable('employee_employment_details', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table
      .uuid('user_id')
      .notNullable()
      .unique()
      .references('id')
      .inTable('users')
      .onDelete('CASCADE');
    table.enu('employment_type', ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN']);
    table.enu('work_mode', ['ONSITE', 'HYBRID', 'REMOTE']);
    table.decimal('base_salary', 12, 2);
    table.string('currency', 3);
    table.text('notes');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // Simple per-user allowances & benefits (normalized key/value form)
  await knex.schema.createTable('employee_benefits', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table
      .enu('benefit_type', [
        'ALLOWANCE_TRANSPORT',
        'ALLOWANCE_MEAL',
        'ALLOWANCE_INTERNET',
        'BENEFIT_HEALTH_INSURANCE',
        'BENEFIT_LIFE_INSURANCE',
        'BENEFIT_COMPANY_DEVICE',
        'BENEFIT_TRAINING',
        'BENEFIT_TUITION',
        'BENEFIT_FITNESS',
        'BENEFIT_MENTAL_HEALTH_SUPPORT',
      ])
      .notNullable();
    table.boolean('enabled').notNullable().defaultTo(true);
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(['user_id', 'benefit_type']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('employee_benefits');
  await knex.schema.dropTableIfExists('employee_employment_details');
}
