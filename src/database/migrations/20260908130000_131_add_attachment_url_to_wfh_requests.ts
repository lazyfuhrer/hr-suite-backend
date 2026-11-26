import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const hasColumn = await knex.schema.hasColumn('wfh_requests', 'attachment_url');
  if (hasColumn) return;

  await knex.schema.alterTable('wfh_requests', (table) => {
    table.text('attachment_url').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  const hasColumn = await knex.schema.hasColumn('wfh_requests', 'attachment_url');
  if (!hasColumn) return;

  await knex.schema.alterTable('wfh_requests', (table) => {
    table.dropColumn('attachment_url');
  });
}
