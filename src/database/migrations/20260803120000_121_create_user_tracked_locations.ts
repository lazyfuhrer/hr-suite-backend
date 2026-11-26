import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('user_tracked_locations', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table
      .uuid('org_id')
      .notNullable()
      .references('id')
      .inTable('organizations')
      .onDelete('CASCADE');
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.string('sdk_uuid', 64).notNullable();
    table.decimal('latitude', 10, 7).notNullable();
    table.decimal('longitude', 10, 7).notNullable();
    table.decimal('accuracy', 12, 4).nullable();
    table.decimal('speed', 12, 4).nullable();
    table.decimal('heading', 12, 4).nullable();
    table.decimal('altitude', 12, 4).nullable();
    table.string('activity_type', 32).nullable();
    table.integer('activity_confidence').nullable();
    table.decimal('battery_level', 6, 4).nullable();
    table.boolean('battery_is_charging').nullable();
    table.string('event', 32).nullable();
    table.boolean('is_moving').nullable();
    table.decimal('odometer', 14, 4).nullable();
    table.integer('age').nullable();
    table.jsonb('extras').nullable();
    table.string('geofence_identifier', 128).nullable();
    table.string('geofence_action', 16).nullable();
    table.timestamp('recorded_at', { useTz: true }).notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(['org_id', 'sdk_uuid'], {
      indexName: 'uq_user_tracked_locations_org_sdk_uuid',
    });
    table.index(
      ['org_id', 'user_id', 'recorded_at'],
      'idx_user_tracked_locations_org_user_recorded',
    );
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('user_tracked_locations');
}
