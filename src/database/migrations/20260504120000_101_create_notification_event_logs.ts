import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('notification_event_logs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));

    table.uuid('org_id').nullable().references('id').inTable('organizations').onDelete('SET NULL');

    table.string('event', 128).notNullable();
    table.enu('scope', ['user', 'org', 'tokens']).notNullable();

    table.text('title').nullable();
    table.text('body').nullable();
    table.text('link').nullable();
    table.jsonb('data').notNullable().defaultTo(knex.raw("'{}'::jsonb"));

    table.jsonb('target_user_ids').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
    table
      .uuid('target_org_id')
      .nullable()
      .references('id')
      .inTable('organizations')
      .onDelete('SET NULL');

    table.integer('token_count').notNullable().defaultTo(0);
    table.integer('success_count').notNullable().defaultTo(0);
    table.integer('failure_count').notNullable().defaultTo(0);
    table.jsonb('invalid_tokens').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
    table.jsonb('responses').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
    table.jsonb('error').nullable();

    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['org_id', 'created_at']);
    table.index(['org_id', 'event', 'created_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('notification_event_logs');
}
