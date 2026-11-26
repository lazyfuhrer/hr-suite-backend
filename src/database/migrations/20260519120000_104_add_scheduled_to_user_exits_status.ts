import type { Knex } from 'knex';

const TABLE = 'user_exits';
const COLUMN = 'status';
const CHECK_NAME = 'user_exits_status_check';

export async function up(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) {
    return;
  }

  await knex.schema.raw(`ALTER TABLE "${TABLE}" DROP CONSTRAINT IF EXISTS "${CHECK_NAME}"`);

  await knex.schema.raw(`
    ALTER TABLE "${TABLE}"
    ADD CONSTRAINT "${CHECK_NAME}"
    CHECK (${COLUMN} IN ('ON_NOTICE', 'COMPLETED', 'CANCELLED', 'SCHEDULED'))
  `);

  await knex.raw('DROP INDEX IF EXISTS idx_user_exits_active_lookup');

  await knex.raw(`
    CREATE INDEX idx_user_exits_active_lookup
    ON user_exits (org_id, user_id)
    WHERE status IN ('SCHEDULED', 'ON_NOTICE', 'COMPLETED')
  `);
}

export async function down(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) {
    return;
  }

  await knex(TABLE)
    .where(COLUMN, 'SCHEDULED')
    .update({ [COLUMN]: 'CANCELLED' });

  await knex.schema.raw(`ALTER TABLE "${TABLE}" DROP CONSTRAINT IF EXISTS "${CHECK_NAME}"`);

  await knex.schema.raw(`
    ALTER TABLE "${TABLE}"
    ADD CONSTRAINT "${CHECK_NAME}"
    CHECK (${COLUMN} IN ('ON_NOTICE', 'COMPLETED', 'CANCELLED'))
  `);

  await knex.raw('DROP INDEX IF EXISTS idx_user_exits_active_lookup');

  await knex.raw(`
    CREATE INDEX idx_user_exits_active_lookup
    ON user_exits (org_id, user_id)
    WHERE status IN ('ON_NOTICE', 'COMPLETED')
  `);
}
