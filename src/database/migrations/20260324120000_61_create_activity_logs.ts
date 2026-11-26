import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable('activity_logs');
  if (hasTable) {
    return;
  }

  await knex.schema.createTable('activity_logs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table
      .uuid('org_id')
      .notNullable()
      .references('id')
      .inTable('organizations')
      .onDelete('CASCADE');
    table.uuid('actor_user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    table.uuid('target_user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    table.string('entity_type', 64).notNullable();
    table.uuid('entity_id').nullable();
    table.string('activity_type', 64).notNullable();
    table.jsonb('metadata').nullable();
    table.timestamps(true, true);

    table.index(['org_id', 'created_at'], 'idx_activity_logs_org_created_at');
    table.index(['org_id', 'activity_type'], 'idx_activity_logs_org_activity_type');
    table.index(['org_id', 'target_user_id'], 'idx_activity_logs_org_target_user_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable('activity_logs');
  if (!hasTable) {
    return;
  }

  await knex.schema.dropTableIfExists('activity_logs');
}
