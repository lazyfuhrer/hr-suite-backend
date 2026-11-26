import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('user_device_tokens', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));

    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.uuid('org_id').nullable().references('id').inTable('organizations').onDelete('SET NULL');

    table.text('token').notNullable().unique();
    table.string('platform').notNullable(); // apns|gcm|web (enforced at API layer)
    table.string('device_id').nullable();

    table.boolean('enabled').notNullable().defaultTo(true);
    table.timestamp('last_seen_at', { useTz: true }).nullable();

    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['user_id', 'enabled']);
    table.index(['org_id', 'enabled']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('user_device_tokens');
}
