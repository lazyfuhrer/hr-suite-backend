import type { Knex } from 'knex';

exports.up = async function (knex: Knex) {
  await knex.schema.createTable('organization_documents', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table
      .uuid('org_id')
      .notNullable()
      .references('id')
      .inTable('organizations')
      .onDelete('CASCADE');
    table
      .enu('doc_category', ['LEGAL', 'COMPLIANCE', 'FINANCIAL', 'OPERATIONAL', 'OTHER'])
      .notNullable();

    table.string('doc_type').notNullable();
    table.text('file_url').notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(['org_id']);
  });
};
exports.down = async function (knex: Knex) {
  await knex.schema.dropTableIfExists('organization_documents');
};
