import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('user_documents', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table
      .enu('doc_category', ['IDENTITY', 'EDUCATION', 'EXPERIENCE', 'FINANCE', 'LEGAL'])
      .notNullable();
    table.string('doc_type').notNullable();
    table.text('file_url').notNullable();
    table
      .enu('verification_status', ['PENDING', 'VERIFIED', 'REJECTED'])
      .notNullable()
      .defaultTo('PENDING');
    table.text('rejection_reason');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('user_onboardings', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table
      .uuid('user_id')
      .notNullable()
      .unique()
      .references('id')
      .inTable('users')
      .onDelete('CASCADE');
    table.enu('asset_device_pref', ['WINDOWS', 'MACBOOK', 'LINUX']);
    table.boolean('asset_agreement_accepted').notNullable().defaultTo(false);
    table.boolean('policy_acknowledged').notNullable().defaultTo(false);
    table.boolean('offer_letter_signed').notNullable().defaultTo(false);
    table.enu('onboarding_status', ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED']);
    table.timestamp('completed_at', { useTz: true });
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('user_onboardings');
  await knex.schema.dropTableIfExists('user_documents');
}
