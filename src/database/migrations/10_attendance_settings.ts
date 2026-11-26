import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('office_locations', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table
      .uuid('org_id')
      .notNullable()
      .references('id')
      .inTable('organizations')
      .onDelete('CASCADE');
    table.string('name').notNullable();
    table.decimal('latitude', 10, 8).notNullable();
    table.decimal('longitude', 11, 8).notNullable();
    table.integer('radius_meters').notNullable().defaultTo(100);
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('work_shifts', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table
      .uuid('org_id')
      .notNullable()
      .references('id')
      .inTable('organizations')
      .onDelete('CASCADE');
    table.string('name').notNullable();
    table.time('start_time').notNullable();
    table.time('end_time').notNullable();
    table.time('break_start_time').notNullable().defaultTo('13:00:00');
    table.time('break_end_time').notNullable().defaultTo('14:00:00');
    table.integer('break_duration_mins').notNullable().defaultTo(60);
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.alterTable('departments', (table) => {
    table.uuid('location_id').references('id').inTable('office_locations').onDelete('SET NULL');
    table.uuid('default_shift_id').references('id').inTable('work_shifts').onDelete('SET NULL');
  });

  await knex.schema.alterTable('users', (table) => {
    table.uuid('shift_id').references('id').inTable('work_shifts').onDelete('SET NULL');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('shift_id');
  });

  await knex.schema.alterTable('departments', (table) => {
    table.dropColumn('default_shift_id');
    table.dropColumn('location_id');
  });

  await knex.schema.dropTableIfExists('work_shifts');
  await knex.schema.dropTableIfExists('office_locations');
}
