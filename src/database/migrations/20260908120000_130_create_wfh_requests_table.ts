import type { Knex } from 'knex';

/**
 * Ensures `wfh_requests` matches the date-range WFH API.
 * Local DBs may already have an older single-day table from a prior
 * (non-stub) create under migration 121 — upgrade in place when present.
 */
export async function up(knex: Knex): Promise<void> {
  const exists = await knex.schema.hasTable('wfh_requests');

  if (!exists) {
    await knex.schema.createTable('wfh_requests', (table) => {
      table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
      table
        .uuid('org_id')
        .notNullable()
        .references('id')
        .inTable('organizations')
        .onDelete('CASCADE');
      table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
      table.uuid('manager_id').nullable().references('id').inTable('users').onDelete('SET NULL');
      table.uuid('hr_id').nullable().references('id').inTable('users').onDelete('SET NULL');
      table.date('start_date').notNullable();
      table.date('end_date').notNullable();
      table.double('total_days').nullable();
      table.text('reason').notNullable();
      table.text('approver_comment').nullable();
      table
        .enu('status', ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'])
        .notNullable()
        .defaultTo('PENDING');
      table
        .enu('manager_status', ['PENDING', 'APPROVED', 'REJECTED'])
        .notNullable()
        .defaultTo('PENDING');
      table
        .enu('hr_status', ['PENDING', 'APPROVED', 'REJECTED'])
        .notNullable()
        .defaultTo('PENDING');
      table.timestamp('manager_action_at', { useTz: true }).nullable();
      table.timestamp('hr_action_at', { useTz: true }).nullable();
      table.timestamp('cancelled_at', { useTz: true }).nullable();
      table.uuid('cancelled_by').nullable().references('id').inTable('users').onDelete('SET NULL');
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      table.index(['org_id', 'user_id'], 'idx_wfh_requests_org_user');
      table.index(['org_id', 'status'], 'idx_wfh_requests_org_status');
      table.index(['org_id', 'start_date', 'end_date'], 'idx_wfh_requests_org_dates');
    });
    return;
  }

  const hasStartDate = await knex.schema.hasColumn('wfh_requests', 'start_date');
  const hasRequestDate = await knex.schema.hasColumn('wfh_requests', 'request_date');

  if (!hasStartDate) {
    await knex.schema.alterTable('wfh_requests', (table) => {
      table.date('start_date').nullable();
      table.date('end_date').nullable();
      table.double('total_days').nullable();
    });

    if (hasRequestDate) {
      await knex.raw(`
        UPDATE wfh_requests
        SET start_date = request_date::date,
            end_date = request_date::date,
            total_days = COALESCE(total_days, 1)
        WHERE start_date IS NULL
      `);
    } else {
      await knex.raw(`
        UPDATE wfh_requests
        SET start_date = COALESCE(start_date, created_at::date),
            end_date = COALESCE(end_date, created_at::date),
            total_days = COALESCE(total_days, 1)
        WHERE start_date IS NULL
      `);
    }

    await knex.raw(`ALTER TABLE wfh_requests ALTER COLUMN start_date SET NOT NULL`);
    await knex.raw(`ALTER TABLE wfh_requests ALTER COLUMN end_date SET NOT NULL`);
  } else if (!(await knex.schema.hasColumn('wfh_requests', 'total_days'))) {
    await knex.schema.alterTable('wfh_requests', (table) => {
      table.double('total_days').nullable();
    });
  }

  // Ensure reason is non-null going forward.
  await knex.raw(`UPDATE wfh_requests SET reason = '' WHERE reason IS NULL`);
  await knex.raw(`ALTER TABLE wfh_requests ALTER COLUMN reason SET NOT NULL`);

  // Drop legacy single-day unique index / column and unused approver fields.
  await knex.raw(`DROP INDEX IF EXISTS wfh_requests_one_pending_per_day`);
  await knex.raw(`DROP INDEX IF EXISTS idx_wfh_requests_org_user_date`);
  await knex.raw(`DROP INDEX IF EXISTS idx_wfh_requests_org_status_created`);

  if (hasRequestDate) {
    await knex.schema.alterTable('wfh_requests', (table) => {
      table.dropColumn('request_date');
    });
  }

  if (await knex.schema.hasColumn('wfh_requests', 'approver_id')) {
    await knex.schema.alterTable('wfh_requests', (table) => {
      table.dropColumn('approver_id');
    });
  }
  if (await knex.schema.hasColumn('wfh_requests', 'approved_at')) {
    await knex.schema.alterTable('wfh_requests', (table) => {
      table.dropColumn('approved_at');
    });
  }

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_wfh_requests_org_user
    ON wfh_requests (org_id, user_id)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_wfh_requests_org_status
    ON wfh_requests (org_id, status)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_wfh_requests_org_dates
    ON wfh_requests (org_id, start_date, end_date)
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Do not drop the table on rollback — it may predate this migration (legacy 121 create).
  // Only reverse additive shape changes when start_date exists and request_date does not.
  const exists = await knex.schema.hasTable('wfh_requests');
  if (!exists) return;

  const hasStartDate = await knex.schema.hasColumn('wfh_requests', 'start_date');
  const hasRequestDate = await knex.schema.hasColumn('wfh_requests', 'request_date');
  if (!hasStartDate || hasRequestDate) return;

  await knex.schema.alterTable('wfh_requests', (table) => {
    table.date('request_date').nullable();
  });
  await knex.raw(`
    UPDATE wfh_requests
    SET request_date = start_date
    WHERE request_date IS NULL
  `);
  await knex.raw(`ALTER TABLE wfh_requests ALTER COLUMN request_date SET NOT NULL`);

  await knex.raw(`DROP INDEX IF EXISTS idx_wfh_requests_org_user`);
  await knex.raw(`DROP INDEX IF EXISTS idx_wfh_requests_org_status`);
  await knex.raw(`DROP INDEX IF EXISTS idx_wfh_requests_org_dates`);

  await knex.schema.alterTable('wfh_requests', (table) => {
    table.dropColumn('start_date');
    table.dropColumn('end_date');
    table.dropColumn('total_days');
  });

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_wfh_requests_org_user_date
    ON wfh_requests (org_id, user_id, request_date)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_wfh_requests_org_status_created
    ON wfh_requests (org_id, status, created_at)
  `);
}
