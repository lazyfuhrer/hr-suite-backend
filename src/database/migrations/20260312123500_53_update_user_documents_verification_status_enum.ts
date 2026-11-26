import type { Knex } from 'knex';

const TABLE = 'user_documents';
const COLUMN = 'verification_status';
const CHECK_NAME = 'user_documents_verification_status_check';

export async function up(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) return;

  const hasColumn = await knex.schema.hasColumn(TABLE, COLUMN);
  if (!hasColumn) return;

  // Drop existing check constraint if present
  await knex.schema.raw(`ALTER TABLE "${TABLE}" DROP CONSTRAINT IF EXISTS "${CHECK_NAME}"`);

  // Migrate legacy REJECTED values to FAILED to align with new enum
  await knex(TABLE)
    .where(COLUMN, 'REJECTED')
    .update({ [COLUMN]: 'FAILED' });

  // Add new constraint allowing IN_PROGRESS and FAILED
  await knex.schema.raw(`
    ALTER TABLE "${TABLE}"
    ADD CONSTRAINT "${CHECK_NAME}"
    CHECK (${COLUMN} IN ('PENDING','IN_PROGRESS','VERIFIED','FAILED'))
  `);

  // Add metadata column for external verification details if it does not exist
  const hasMetaColumn = await knex.schema.hasColumn(TABLE, 'verification_meta');
  if (!hasMetaColumn) {
    await knex.schema.alterTable(TABLE, (table) => {
      table.jsonb('verification_meta');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) return;

  const hasColumn = await knex.schema.hasColumn(TABLE, COLUMN);
  if (!hasColumn) return;

  // Revert FAILED back to REJECTED before restoring original constraint
  await knex(TABLE)
    .where(COLUMN, 'FAILED')
    .update({ [COLUMN]: 'REJECTED' });

  // Drop new constraint
  await knex.schema.raw(`ALTER TABLE "${TABLE}" DROP CONSTRAINT IF EXISTS "${CHECK_NAME}"`);

  // Restore original constraint: PENDING, VERIFIED, REJECTED
  await knex.schema.raw(`
    ALTER TABLE "${TABLE}"
    ADD CONSTRAINT "${CHECK_NAME}"
    CHECK (${COLUMN} IN ('PENDING','VERIFIED','REJECTED'))
  `);

  const hasMetaColumn = await knex.schema.hasColumn(TABLE, 'verification_meta');
  if (hasMetaColumn) {
    await knex.schema.alterTable(TABLE, (table) => {
      table.dropColumn('verification_meta');
    });
  }
}
