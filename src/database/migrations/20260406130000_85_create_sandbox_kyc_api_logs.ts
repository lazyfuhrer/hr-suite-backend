import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable('sandbox_kyc_api_logs');
  if (hasTable) {
    return;
  }

  await knex.schema.createTable('sandbox_kyc_api_logs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('org_id').nullable().references('id').inTable('organizations').onDelete('CASCADE');
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.string('api_kind', 32).notNullable();
    table.integer('http_status').notNullable();
    table.jsonb('response_body').notNullable();
    table.timestamps(true, true);

    table.index(['org_id', 'created_at'], 'idx_sandbox_kyc_logs_org_created');
    table.index(['org_id', 'user_id'], 'idx_sandbox_kyc_logs_org_user');
    table.index(['api_kind'], 'idx_sandbox_kyc_logs_api_kind');
  });
}

export async function down(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable('sandbox_kyc_api_logs');
  if (!hasTable) {
    return;
  }

  await knex.schema.dropTableIfExists('sandbox_kyc_api_logs');
}
