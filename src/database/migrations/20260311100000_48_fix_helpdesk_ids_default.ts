import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const hasTickets = await knex.schema.hasTable('helpdesk_tickets');
  if (hasTickets) {
    await knex.raw(
      'ALTER TABLE "helpdesk_tickets" ALTER COLUMN "id" SET DEFAULT uuid_generate_v4()',
    );
  }

  const hasComments = await knex.schema.hasTable('helpdesk_ticket_comments');
  if (hasComments) {
    await knex.raw(
      'ALTER TABLE "helpdesk_ticket_comments" ALTER COLUMN "id" SET DEFAULT uuid_generate_v4()',
    );
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasTickets = await knex.schema.hasTable('helpdesk_tickets');
  if (hasTickets) {
    await knex.raw('ALTER TABLE "helpdesk_tickets" ALTER COLUMN "id" DROP DEFAULT');
  }

  const hasComments = await knex.schema.hasTable('helpdesk_ticket_comments');
  if (hasComments) {
    await knex.raw('ALTER TABLE "helpdesk_ticket_comments" ALTER COLUMN "id" DROP DEFAULT');
  }
}
