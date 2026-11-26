import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('user_identities', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.enu('id_type', ['AADHAAR', 'PAN', 'PASSPORT', 'DRIVING_LICENSE']).notNullable();
    table.string('id_number').notNullable();
    table.string('name_on_document');
    table.date('valid_till');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(['user_id', 'id_type']);
  });

  await knex.schema.createTable('bank_details', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table
      .uuid('user_id')
      .notNullable()
      .unique()
      .references('id')
      .inTable('users')
      .onDelete('CASCADE');
    table.string('account_holder_name');
    table.string('account_number');
    table.string('ifsc_code');
    table.string('bank_name');
    table.string('branch_name');
    table.enu('account_type', ['SAVINGS', 'CURRENT', 'SALARY']).notNullable().defaultTo('SALARY');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('bank_details');
  await knex.schema.dropTableIfExists('user_identities');
}
