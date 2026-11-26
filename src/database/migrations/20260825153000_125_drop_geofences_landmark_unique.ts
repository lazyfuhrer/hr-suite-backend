import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('geofences', (table) => {
    table.dropUnique(['org_id', 'landmark'], 'uq_geofences_org_landmark');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('geofences', (table) => {
    table.unique(['org_id', 'landmark'], 'uq_geofences_org_landmark');
  });
}
