import type { Knex } from 'knex';

const TABLE = 'user_onboardings';

export async function up(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) return;

  const hasKycStatus = await knex.schema.hasColumn(TABLE, 'kyc_status');
  const hasKycFailureReason = await knex.schema.hasColumn(TABLE, 'kyc_failure_reason');
  const hasKycCheckedAt = await knex.schema.hasColumn(TABLE, 'kyc_checked_at');
  const hasKycProvider = await knex.schema.hasColumn(TABLE, 'kyc_provider');

  await knex.schema.alterTable(TABLE, (table) => {
    if (!hasKycStatus) {
      table
        .enu('kyc_status', ['NOT_REQUIRED', 'PENDING', 'IN_PROGRESS', 'VERIFIED', 'FAILED'])
        .nullable()
        .defaultTo('PENDING');
    }
    if (!hasKycFailureReason) {
      table.text('kyc_failure_reason');
    }
    if (!hasKycCheckedAt) {
      table.timestamp('kyc_checked_at', { useTz: true });
    }
    if (!hasKycProvider) {
      table.string('kyc_provider');
    }
  });
}

export async function down(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) return;

  const hasKycStatus = await knex.schema.hasColumn(TABLE, 'kyc_status');
  const hasKycFailureReason = await knex.schema.hasColumn(TABLE, 'kyc_failure_reason');
  const hasKycCheckedAt = await knex.schema.hasColumn(TABLE, 'kyc_checked_at');
  const hasKycProvider = await knex.schema.hasColumn(TABLE, 'kyc_provider');

  await knex.schema.alterTable(TABLE, (table) => {
    if (hasKycStatus) {
      table.dropColumn('kyc_status');
    }
    if (hasKycFailureReason) {
      table.dropColumn('kyc_failure_reason');
    }
    if (hasKycCheckedAt) {
      table.dropColumn('kyc_checked_at');
    }
    if (hasKycProvider) {
      table.dropColumn('kyc_provider');
    }
  });
}
