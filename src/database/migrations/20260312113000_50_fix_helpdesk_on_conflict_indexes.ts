import type { Knex } from 'knex';

/**
 * Fix Postgres ON CONFLICT inference for linked tickets.
 *
 * Previously we created *partial* unique indexes:
 *  - (org_id, leave_request_id) WHERE leave_request_id IS NOT NULL
 *  - (org_id, attendance_correction_request_id) WHERE attendance_correction_request_id IS NOT NULL
 *
 * Postgres cannot infer partial unique indexes from `ON CONFLICT (col1, col2)`
 * unless the conflict target includes a matching WHERE clause.
 *
 * A normal UNIQUE index already allows multiple NULLs in Postgres, so we can
 * safely use non-partial unique indexes and keep the code as-is.
 */
export async function up(knex: Knex): Promise<void> {
  // Drop old partial indexes if they exist
  await knex.raw(`DROP INDEX IF EXISTS "uq_helpdesk_tickets_org_leave_request"`);
  await knex.raw(`DROP INDEX IF EXISTS "uq_helpdesk_tickets_org_attendance_request"`);

  // Create non-partial unique indexes (NULLs are allowed in Postgres unique indexes)
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS "uq_helpdesk_tickets_org_leave_request"
    ON "helpdesk_tickets" ("org_id", "leave_request_id")
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS "uq_helpdesk_tickets_org_attendance_request"
    ON "helpdesk_tickets" ("org_id", "attendance_correction_request_id")
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Revert to partial unique indexes (best-effort)
  await knex.raw(`DROP INDEX IF EXISTS "uq_helpdesk_tickets_org_leave_request"`);
  await knex.raw(`DROP INDEX IF EXISTS "uq_helpdesk_tickets_org_attendance_request"`);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS "uq_helpdesk_tickets_org_leave_request"
    ON "helpdesk_tickets" ("org_id", "leave_request_id")
    WHERE leave_request_id IS NOT NULL
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS "uq_helpdesk_tickets_org_attendance_request"
    ON "helpdesk_tickets" ("org_id", "attendance_correction_request_id")
    WHERE attendance_correction_request_id IS NOT NULL
  `);
}
