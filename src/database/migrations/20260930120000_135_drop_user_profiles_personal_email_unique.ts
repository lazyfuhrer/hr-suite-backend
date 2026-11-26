import type { Knex } from 'knex';

const TABLE = 'user_profiles';
const CONSTRAINT = 'user_profiles_personal_email_unique';

export async function up(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) return;

  await knex.schema.alterTable(TABLE, (table) => {
    table.dropUnique(['personal_email'], CONSTRAINT);
  });
}

export async function down(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) return;

  await knex.schema.alterTable(TABLE, (table) => {
    table.unique(['personal_email'], CONSTRAINT);
  });
}
