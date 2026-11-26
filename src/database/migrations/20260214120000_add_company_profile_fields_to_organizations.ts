import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('organizations', (table) => {
    table.text('favicon_url');
    table.string('brand_color', 32);
    table.string('website');
    table.integer('founded_year');
    table.string('phone_number');
    table.string('cin');
    table.string('gstin');
    table.string('pf_number');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('organizations', (table) => {
    table.dropColumn('favicon_url');
    table.dropColumn('brand_color');
    table.dropColumn('website');
    table.dropColumn('founded_year');
    table.dropColumn('phone_number');
    table.dropColumn('cin');
    table.dropColumn('gstin');
    table.dropColumn('pf_number');
  });
}
