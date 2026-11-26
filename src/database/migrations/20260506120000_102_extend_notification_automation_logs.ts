import type { Knex } from 'knex';

const TABLE = 'notification_automation_logs';

export async function up(knex: Knex): Promise<void> {
  const hasAttemptCount = await knex.schema.hasColumn(TABLE, 'attempt_count');
  const hasLastAttemptAt = await knex.schema.hasColumn(TABLE, 'last_attempt_at');
  const hasLastError = await knex.schema.hasColumn(TABLE, 'last_error');
  const hasCorrelationId = await knex.schema.hasColumn(TABLE, 'correlation_id');
  const hasNextRetryAt = await knex.schema.hasColumn(TABLE, 'next_retry_at');

  if (hasAttemptCount && hasLastAttemptAt && hasLastError && hasCorrelationId && hasNextRetryAt) {
    return;
  }

  await knex.schema.alterTable(TABLE, (table) => {
    if (!hasAttemptCount) table.integer('attempt_count').notNullable().defaultTo(0);
    if (!hasLastAttemptAt) table.timestamp('last_attempt_at', { useTz: true }).nullable();
    if (!hasLastError) table.jsonb('last_error').nullable();
    if (!hasCorrelationId) table.uuid('correlation_id').nullable();
    if (!hasNextRetryAt) table.timestamp('next_retry_at', { useTz: true }).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  const hasAttemptCount = await knex.schema.hasColumn(TABLE, 'attempt_count');
  const hasLastAttemptAt = await knex.schema.hasColumn(TABLE, 'last_attempt_at');
  const hasLastError = await knex.schema.hasColumn(TABLE, 'last_error');
  const hasCorrelationId = await knex.schema.hasColumn(TABLE, 'correlation_id');
  const hasNextRetryAt = await knex.schema.hasColumn(TABLE, 'next_retry_at');

  if (
    !hasAttemptCount &&
    !hasLastAttemptAt &&
    !hasLastError &&
    !hasCorrelationId &&
    !hasNextRetryAt
  ) {
    return;
  }

  await knex.schema.alterTable(TABLE, (table) => {
    if (hasNextRetryAt) table.dropColumn('next_retry_at');
    if (hasCorrelationId) table.dropColumn('correlation_id');
    if (hasLastError) table.dropColumn('last_error');
    if (hasLastAttemptAt) table.dropColumn('last_attempt_at');
    if (hasAttemptCount) table.dropColumn('attempt_count');
  });
}
