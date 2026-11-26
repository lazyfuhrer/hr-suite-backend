import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('attendance_logs', (table) => {
    table.bigIncrements('id').primary();
    table
      .uuid('org_id')
      .notNullable()
      .references('id')
      .inTable('organizations')
      .onDelete('CASCADE');
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.date('date').notNullable();
    table.timestamp('clock_in_time', { useTz: true });
    table.timestamp('clock_out_time', { useTz: true });
    table.decimal('total_work_hours', 5, 2);
    table.enu('status', ['PRESENT', 'ABSENT']).notNullable().defaultTo('ABSENT');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('attendance_breaks', (table) => {
    table.bigIncrements('id').primary();
    table
      .bigInteger('attendance_log_id')
      .notNullable()
      .references('id')
      .inTable('attendance_logs')
      .onDelete('CASCADE');
    table.enu('break_type', ['LUNCH', 'TEA']).notNullable();
    table.timestamp('start_time', { useTz: true }).notNullable();
    table.timestamp('end_time', { useTz: true });
  });

  await knex.schema.createTable('leave_types', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table
      .uuid('org_id')
      .notNullable()
      .references('id')
      .inTable('organizations')
      .onDelete('CASCADE');
    table.string('name').notNullable();
    table.integer('annual_quota').notNullable();
  });

  await knex.schema.createTable('leave_requests', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table
      .uuid('org_id')
      .notNullable()
      .references('id')
      .inTable('organizations')
      .onDelete('CASCADE');
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.uuid('manager_id').references('id').inTable('users');
    table
      .uuid('leave_type_id')
      .notNullable()
      .references('id')
      .inTable('leave_types')
      .onDelete('CASCADE');
    table.date('start_date').notNullable();
    table.date('end_date').notNullable();
    table.text('reason');
    table.enu('status', ['PENDING', 'APPROVED', 'REJECTED']).notNullable().defaultTo('PENDING');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('tickets', (table) => {
    table.bigIncrements('id').primary();
    table
      .uuid('org_id')
      .notNullable()
      .references('id')
      .inTable('organizations')
      .onDelete('CASCADE');
    table.uuid('raiser_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.uuid('assigned_to').references('id').inTable('users');
    table.string('category');
    table.enu('priority', ['LOW', 'MEDIUM', 'HIGH']).notNullable();
    table.string('subject').notNullable();
    table.text('description');
    table.enu('status', ['OPEN', 'IN_PROGRESS', 'RESOLVED']).notNullable().defaultTo('OPEN');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

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
  await knex.schema.dropTableIfExists('tickets');
  await knex.schema.dropTableIfExists('leave_requests');
  await knex.schema.dropTableIfExists('leave_types');
  await knex.schema.dropTableIfExists('attendance_breaks');
  await knex.schema.dropTableIfExists('attendance_logs');
}
