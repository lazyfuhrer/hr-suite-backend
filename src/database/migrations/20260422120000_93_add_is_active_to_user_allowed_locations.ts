import type { Knex } from 'knex';

const TABLE = 'user_allowed_locations';
const COLUMN = 'is_active';

export async function up(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) return;

  const hasColumn = await knex.schema.hasColumn(TABLE, COLUMN);
  if (!hasColumn) {
    await knex.schema.alterTable(TABLE, (table) => {
      table.boolean(COLUMN).notNullable().defaultTo(true);
    });
  }

  // Helpful for filtering active rows per user.
  await knex.schema.alterTable(TABLE, (table) => {
    table.index(['org_id', 'user_id', COLUMN], 'idx_user_allowed_locations_org_user_active');
  });
}

export async function down(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) return;

  const hasColumn = await knex.schema.hasColumn(TABLE, COLUMN);
  if (hasColumn) {
    await knex.schema.alterTable(TABLE, (table) => {
      table.dropIndex(['org_id', 'user_id', COLUMN], 'idx_user_allowed_locations_org_user_active');
      table.dropColumn(COLUMN);
    });
  }
}
