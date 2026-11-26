import type { Knex } from 'knex';

const TABLE = 'bank_details';

export async function up(knex: Knex): Promise<void> {
  const hasVerificationStatus = await knex.schema.hasColumn(TABLE, 'verification_status');
  const hasFailureReason = await knex.schema.hasColumn(TABLE, 'verification_failure_reason');
  const hasCheckedAt = await knex.schema.hasColumn(TABLE, 'verification_checked_at');
  const hasProvider = await knex.schema.hasColumn(TABLE, 'verification_provider');
  const hasMeta = await knex.schema.hasColumn(TABLE, 'verification_meta');

  await knex.schema.alterTable(TABLE, (table) => {
    if (!hasVerificationStatus) {
      table.string('verification_status').notNullable().defaultTo('PENDING');
    }
    if (!hasFailureReason) {
      table.text('verification_failure_reason').nullable();
    }
    if (!hasCheckedAt) {
      table.timestamp('verification_checked_at', { useTz: true }).nullable();
    }
    if (!hasProvider) {
      table.string('verification_provider').nullable();
    }
    if (!hasMeta) {
      table.jsonb('verification_meta').nullable();
    }
  });

  await knex(TABLE).whereNull('verification_status').update({ verification_status: 'PENDING' });
}

export async function down(knex: Knex): Promise<void> {
  const hasVerificationStatus = await knex.schema.hasColumn(TABLE, 'verification_status');
  const hasFailureReason = await knex.schema.hasColumn(TABLE, 'verification_failure_reason');
  const hasCheckedAt = await knex.schema.hasColumn(TABLE, 'verification_checked_at');
  const hasProvider = await knex.schema.hasColumn(TABLE, 'verification_provider');
  const hasMeta = await knex.schema.hasColumn(TABLE, 'verification_meta');

  await knex.schema.alterTable(TABLE, (table) => {
    if (hasMeta) {
      table.dropColumn('verification_meta');
    }
    if (hasProvider) {
      table.dropColumn('verification_provider');
    }
    if (hasCheckedAt) {
      table.dropColumn('verification_checked_at');
    }
    if (hasFailureReason) {
      table.dropColumn('verification_failure_reason');
    }
    if (hasVerificationStatus) {
      table.dropColumn('verification_status');
    }
  });
}
