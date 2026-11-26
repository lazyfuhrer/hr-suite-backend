const HELP_DESK_RESOLUTION_CHECK = 'helpdesk_tickets_resolution_check';

import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    `ALTER TABLE "helpdesk_tickets" DROP CONSTRAINT IF EXISTS "${HELP_DESK_RESOLUTION_CHECK}"`,
  );
  await knex.raw(`
    ALTER TABLE "helpdesk_tickets"
    ADD CONSTRAINT "${HELP_DESK_RESOLUTION_CHECK}"
    CHECK (
      resolution IS NULL
      OR resolution = ANY (
        ARRAY[
          'PENDING'::text,
          'APPROVED'::text,
          'REJECTED'::text
        ]
      )
    )
  `);
  await knex.raw(`
    ALTER TABLE "helpdesk_tickets"
    ALTER COLUMN "resolution" SET DEFAULT 'PENDING'
  `);
  // Backfill existing rows that have NULL resolution to PENDING
  await knex('helpdesk_tickets').whereNull('resolution').update({ resolution: 'PENDING' });
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE "helpdesk_tickets" ALTER COLUMN "resolution" DROP DEFAULT`);
  await knex.raw(
    `ALTER TABLE "helpdesk_tickets" DROP CONSTRAINT IF EXISTS "${HELP_DESK_RESOLUTION_CHECK}"`,
  );
  await knex.raw(`
    ALTER TABLE "helpdesk_tickets"
    ADD CONSTRAINT "${HELP_DESK_RESOLUTION_CHECK}"
    CHECK (
      resolution IS NULL
      OR resolution = ANY (
        ARRAY[
          'APPROVED'::text,
          'REJECTED'::text
        ]
      )
    )
  `);
}
