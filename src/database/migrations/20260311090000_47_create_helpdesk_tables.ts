import type { Knex } from 'knex';

const HELP_DESK_CATEGORY_CHECK = 'helpdesk_tickets_category_check';
const HELP_DESK_PRIORITY_CHECK = 'helpdesk_tickets_priority_check';
const HELP_DESK_STATUS_CHECK = 'helpdesk_tickets_status_check';
const HELP_DESK_RESOLUTION_CHECK = 'helpdesk_tickets_resolution_check';

export async function up(knex: Knex): Promise<void> {
  const hasTickets = await knex.schema.hasTable('helpdesk_tickets');
  if (!hasTickets) {
    await knex.schema.createTable('helpdesk_tickets', (table) => {
      table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
      table.uuid('org_id').notNullable().references('id').inTable('organizations');
      table.uuid('created_by').notNullable().references('id').inTable('users').onDelete('CASCADE');
      table.uuid('assigned_to').nullable().references('id').inTable('users').onDelete('SET NULL');

      table.string('category', 32).notNullable();
      table.string('subject', 255).notNullable();
      table.text('description').notNullable();
      table.string('priority', 16).notNullable().defaultTo('MEDIUM');
      table.string('status', 16).notNullable().defaultTo('OPEN');
      table.string('resolution', 16).nullable();

      table.uuid('leave_request_id').nullable().references('id').inTable('leave_requests');
      table
        .uuid('attendance_correction_request_id')
        .nullable()
        .references('id')
        .inTable('attendance_correction_requests');

      table.string('attachment_file_key').nullable();
      table.string('attachment_file_url').nullable();

      table.timestamps(true, true);

      table.index(['org_id', 'category'], 'idx_helpdesk_tickets_org_category');
      table.index(['org_id', 'status'], 'idx_helpdesk_tickets_org_status');
      table.index(['org_id', 'created_by'], 'idx_helpdesk_tickets_org_created_by');
    });

    // Add check constraints for category/priority/status/resolution
    await knex.raw(`
      ALTER TABLE "helpdesk_tickets"
      ADD CONSTRAINT "${HELP_DESK_CATEGORY_CHECK}"
      CHECK (
        category = ANY (
          ARRAY[
            'it_support'::text,
            'hr_query'::text,
            'payroll'::text,
            'attendance'::text,
            'leave'::text
          ]
        )
      )
    `);

    await knex.raw(`
      ALTER TABLE "helpdesk_tickets"
      ADD CONSTRAINT "${HELP_DESK_PRIORITY_CHECK}"
      CHECK (
        priority = ANY (
          ARRAY[
            'LOW'::text,
            'MEDIUM'::text,
            'HIGH'::text
          ]
        )
      )
    `);

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

    // Ensure we do not create duplicate tickets for the same underlying request
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

  const hasComments = await knex.schema.hasTable('helpdesk_ticket_comments');
  if (!hasComments) {
    await knex.schema.createTable('helpdesk_ticket_comments', (table) => {
      table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
      table
        .uuid('ticket_id')
        .notNullable()
        .references('id')
        .inTable('helpdesk_tickets')
        .onDelete('CASCADE');
      table.uuid('org_id').notNullable().references('id').inTable('organizations');
      table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');

      table.text('message').notNullable();
      table.string('file_key').nullable();
      table.string('file_url').nullable();

      table.timestamps(true, true);

      table.index(['ticket_id'], 'idx_helpdesk_ticket_comments_ticket_id');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasComments = await knex.schema.hasTable('helpdesk_ticket_comments');
  if (hasComments) {
    await knex.schema.dropTableIfExists('helpdesk_ticket_comments');
  }

  const hasTickets = await knex.schema.hasTable('helpdesk_tickets');
  if (hasTickets) {
    await knex.raw(
      `ALTER TABLE "helpdesk_tickets" DROP CONSTRAINT IF EXISTS "${HELP_DESK_CATEGORY_CHECK}"`,
    );
    await knex.raw(
      `ALTER TABLE "helpdesk_tickets" DROP CONSTRAINT IF EXISTS "${HELP_DESK_PRIORITY_CHECK}"`,
    );
    await knex.raw(
      `ALTER TABLE "helpdesk_tickets" DROP CONSTRAINT IF EXISTS "${HELP_DESK_STATUS_CHECK}"`,
    );
    await knex.raw(
      `ALTER TABLE "helpdesk_tickets" DROP CONSTRAINT IF EXISTS "${HELP_DESK_RESOLUTION_CHECK}"`,
    );

    await knex.schema.dropTableIfExists('helpdesk_tickets');
  }
}
