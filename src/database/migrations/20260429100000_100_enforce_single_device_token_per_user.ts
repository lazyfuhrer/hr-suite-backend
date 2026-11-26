import type { Knex } from 'knex';

const UNIQUE_NAME = 'user_device_tokens_user_id_unique';

export async function up(knex: Knex): Promise<void> {
  // Deduplicate existing rows before enforcing uniqueness.
  // Keep the most recently seen/updated row per user.
  await knex.raw(`
    WITH ranked AS (
      SELECT
        id,
        user_id,
        ROW_NUMBER() OVER (
          PARTITION BY user_id
          ORDER BY last_seen_at DESC NULLS LAST, updated_at DESC, created_at DESC
        ) AS rn
      FROM user_device_tokens
    )
    DELETE FROM user_device_tokens udt
    USING ranked r
    WHERE udt.id = r.id AND r.rn > 1;
  `);

  await knex.schema.alterTable('user_device_tokens', (table) => {
    table.unique(['user_id'], { indexName: UNIQUE_NAME });
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user_device_tokens', (table) => {
    table.dropUnique(['user_id'], UNIQUE_NAME);
  });
}
