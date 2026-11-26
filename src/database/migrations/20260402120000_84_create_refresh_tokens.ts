import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('refresh_tokens', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    // Store only a hash of the refresh token. Never store the raw token.
    table.string('token_hash').notNullable().unique();

    // tenant => users.id, platform => super_admins.id
    table.enu('subject_type', ['tenant', 'platform']).notNullable();
    table.uuid('subject_id').notNullable();

    // Required for tenant tokens; not used for platform tokens.
    table.uuid('org_id').nullable().references('id').inTable('organizations').onDelete('SET NULL');

    // tenant role value (admin|hr|manager|employee) or 'super_admin'
    table.string('role').notNullable();

    table.timestamp('expires_at', { useTz: true }).notNullable();

    table.timestamp('revoked_at', { useTz: true });

    // Points to the next refresh token in the rotation chain.
    table
      .uuid('replaced_by')
      .nullable()
      .references('id')
      .inTable('refresh_tokens')
      .onDelete('SET NULL');

    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['subject_type', 'subject_id', 'revoked_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('refresh_tokens');
}
