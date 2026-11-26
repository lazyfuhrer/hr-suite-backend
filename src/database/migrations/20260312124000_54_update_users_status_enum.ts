import type { Knex } from 'knex';

const TABLE = 'users';
const COLUMN = 'status';
const CHECK_NAME = 'users_status_check';

export async function up(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) return;

  const hasColumn = await knex.schema.hasColumn(TABLE, COLUMN);
  if (!hasColumn) return;

  // Drop existing status check constraint if present
  await knex.schema.raw(`ALTER TABLE "${TABLE}" DROP CONSTRAINT IF EXISTS "${CHECK_NAME}"`);

  // Extend allowed statuses to support reverse onboarding
  await knex.schema.raw(`
    ALTER TABLE "${TABLE}"
    ADD CONSTRAINT "${CHECK_NAME}"
    CHECK (${COLUMN} IN ('ACTIVE','INACTIVE','ON_NOTICE','INVITED','IN_PROGRESS','REJECTED'))
  `);
}

export async function down(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) return;

  const hasColumn = await knex.schema.hasColumn(TABLE, COLUMN);
  if (!hasColumn) return;

  // Any users currently in new statuses must be normalized before restoring the old constraint
  await knex(TABLE)
    .whereIn(COLUMN, ['INVITED', 'IN_PROGRESS', 'REJECTED'])
    .update({ [COLUMN]: 'INACTIVE' });

  await knex.schema.raw(`ALTER TABLE "${TABLE}" DROP CONSTRAINT IF EXISTS "${CHECK_NAME}"`);

  await knex.schema.raw(`
    ALTER TABLE "${TABLE}"
    ADD CONSTRAINT "${CHECK_NAME}"
    CHECK (${COLUMN} IN ('ACTIVE','INACTIVE','ON_NOTICE'))
  `);
}
