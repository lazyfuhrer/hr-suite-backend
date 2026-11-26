import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('geofences', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table
      .uuid('org_id')
      .notNullable()
      .references('id')
      .inTable('organizations')
      .onDelete('CASCADE');
    table.string('landmark', 255).notNullable();
    table.decimal('latitude', 10, 8).notNullable();
    table.decimal('longitude', 11, 8).notNullable();
    table.integer('radius_meters').notNullable().defaultTo(100);
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(['org_id', 'landmark'], 'uq_geofences_org_landmark');
    table.index(['org_id'], 'idx_geofences_org');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('geofences');
}
