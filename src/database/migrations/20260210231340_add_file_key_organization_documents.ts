import type { Knex } from 'knex';

exports.up = async function (knex: Knex) {
  return knex.schema.table('organization_documents', (table) => {
    table.text('file_key');
  });
};

exports.down = function (knex: Knex) {
  return knex.schema.table('organization_documents', (table) => {
    table.dropColumn('file_key');
  });
};
