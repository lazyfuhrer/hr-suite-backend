import type { Knex } from 'knex';

const TABLE = 'organizations';

export async function up(knex: Knex): Promise<void> {
  const hasFaceClock = await knex.schema.hasColumn(TABLE, 'face_clock_enabled');
  if (hasFaceClock) {
    await knex.schema.alterTable(TABLE, (table) => {
      table.boolean('face_clock_enabled').notNullable().defaultTo(false).alter();
    });
  }

  const hasKyc = await knex.schema.hasColumn(TABLE, 'kyc_flow_enabled');
  if (hasKyc) {
    await knex.schema.alterTable(TABLE, (table) => {
      table.boolean('kyc_flow_enabled').notNullable().defaultTo(false).alter();
    });
  }

  await knex(TABLE).update({
    ...(hasFaceClock ? { face_clock_enabled: false } : {}),
    ...(hasKyc ? { kyc_flow_enabled: false } : {}),
  });
}

export async function down(knex: Knex): Promise<void> {
  const hasFaceClock = await knex.schema.hasColumn(TABLE, 'face_clock_enabled');
  if (hasFaceClock) {
    await knex.schema.alterTable(TABLE, (table) => {
      table.boolean('face_clock_enabled').notNullable().defaultTo(true).alter();
    });
  }

  const hasKyc = await knex.schema.hasColumn(TABLE, 'kyc_flow_enabled');
  if (hasKyc) {
    await knex.schema.alterTable(TABLE, (table) => {
      table.boolean('kyc_flow_enabled').notNullable().defaultTo(true).alter();
    });
  }
}
