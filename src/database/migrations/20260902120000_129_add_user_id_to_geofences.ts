import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('geofences', (table) => {
    table.uuid('user_id').nullable().references('id').inTable('users').onDelete('CASCADE');
    table.index(['org_id', 'user_id'], 'idx_geofences_org_user');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('geofences', (table) => {
    table.dropIndex(['org_id', 'user_id'], 'idx_geofences_org_user');
    table.dropColumn('user_id');
  });
}
