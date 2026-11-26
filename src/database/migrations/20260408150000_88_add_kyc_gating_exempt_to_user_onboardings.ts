import type { Knex } from 'knex';

const TABLE = 'user_onboardings';

export async function up(knex: Knex): Promise<void> {
  const hasCol = await knex.schema.hasColumn(TABLE, 'kyc_gating_exempt');
  if (!hasCol) {
    await knex.schema.alterTable(TABLE, (table) => {
      table.boolean('kyc_gating_exempt').notNullable().defaultTo(false);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasCol = await knex.schema.hasColumn(TABLE, 'kyc_gating_exempt');
  if (hasCol) {
    await knex.schema.alterTable(TABLE, (table) => {
      table.dropColumn('kyc_gating_exempt');
    });
  }
}
