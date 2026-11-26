import type { Knex } from 'knex';

const HELP_DESK_STATUS_CHECK = 'helpdesk_tickets_status_check';
const HELP_DESK_RESOLUTION_CHECK = 'helpdesk_tickets_resolution_check';

export async function up(knex: Knex): Promise<void> {
  // Remove old resolution constraint/column (if present)
  await knex.raw(
    `ALTER TABLE "helpdesk_tickets" DROP CONSTRAINT IF EXISTS "${HELP_DESK_RESOLUTION_CHECK}"`,
  );

  const hasResolutionColumn = await knex.schema.hasColumn('helpdesk_tickets', 'resolution');
  if (hasResolutionColumn) {
    await knex.schema.alterTable('helpdesk_tickets', (table) => {
      table.dropColumn('resolution');
    });
  }

  // Extend status enum values to include REOPENED
  await knex.raw(
    `ALTER TABLE "helpdesk_tickets" DROP CONSTRAINT IF EXISTS "${HELP_DESK_STATUS_CHECK}"`,
  );
  await knex.raw(`
    ALTER TABLE "helpdesk_tickets"
    ADD CONSTRAINT "${HELP_DESK_STATUS_CHECK}"
    CHECK (
      status = ANY (
        ARRAY[
          'OPEN'::text,
          'IN_PROGRESS'::text,
          'RESOLVED'::text,
          'REOPENED'::text
        ]
      )
    )
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Revert status constraint (remove REOPENED)
  await knex.raw(
    `ALTER TABLE "helpdesk_tickets" DROP CONSTRAINT IF EXISTS "${HELP_DESK_STATUS_CHECK}"`,
  );
  await knex.raw(`
    ALTER TABLE "helpdesk_tickets"
    ADD CONSTRAINT "${HELP_DESK_STATUS_CHECK}"
    CHECK (
      status = ANY (
        ARRAY[
          'OPEN'::text,
          'IN_PROGRESS'::text,
          'RESOLVED'::text
        ]
      )
    )
  `);

  // Re-add resolution column for rollback compatibility (nullable; no constraint)
  const hasResolutionColumn = await knex.schema.hasColumn('helpdesk_tickets', 'resolution');
  if (!hasResolutionColumn) {
    await knex.schema.alterTable('helpdesk_tickets', (table) => {
      table.string('resolution', 16).nullable();
    });
  }
}
