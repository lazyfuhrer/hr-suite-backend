import type { Knex } from 'knex';

const TICKETS_TABLE = 'helpdesk_tickets';
const COMMENTS_TABLE = 'helpdesk_ticket_comments';
const ORG_TABLE = 'organizations';
const ORG_COLUMN = 'org_id';

const TICKETS_FK_NAME = 'helpdesk_tickets_org_id_foreign';
const COMMENTS_FK_NAME = 'helpdesk_ticket_comments_org_id_foreign';

async function recreateOrgFk(
  knex: Knex,
  tableName: string,
  constraintName: string,
  onDeleteAction: 'CASCADE' | 'NO ACTION',
): Promise<void> {
  const existingConstraintResult = await knex.raw<{ rows: Array<{ constraint_name: string }> }>(
    `
    SELECT tc.constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
     AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND tc.table_name = ?
      AND kcu.column_name = ?
      AND ccu.table_name = ?
      AND ccu.column_name = 'id'
    LIMIT 1;
    `,
    [tableName, ORG_COLUMN, ORG_TABLE],
  );
  const existingConstraintName = existingConstraintResult.rows?.[0]?.constraint_name;
  try {
    if (existingConstraintName) {
      await knex.raw('ALTER TABLE ?? DROP CONSTRAINT ??', [tableName, existingConstraintName]);
    }
    await knex.raw('ALTER TABLE ?? DROP CONSTRAINT IF EXISTS ??', [tableName, constraintName]);
    await knex.raw(
      `ALTER TABLE ?? ADD CONSTRAINT ?? FOREIGN KEY (??) REFERENCES ??(??) ON DELETE ${onDeleteAction}`,
      [tableName, constraintName, ORG_COLUMN, ORG_TABLE, 'id'],
    );
  } catch (error) {
    throw error;
  }
}

export async function up(knex: Knex): Promise<void> {
  const hasTickets = await knex.schema.hasTable(TICKETS_TABLE);
  if (hasTickets) {
    await recreateOrgFk(knex, TICKETS_TABLE, TICKETS_FK_NAME, 'CASCADE');
  }

  const hasComments = await knex.schema.hasTable(COMMENTS_TABLE);
  if (hasComments) {
    await recreateOrgFk(knex, COMMENTS_TABLE, COMMENTS_FK_NAME, 'CASCADE');
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasTickets = await knex.schema.hasTable(TICKETS_TABLE);
  if (hasTickets) {
    await recreateOrgFk(knex, TICKETS_TABLE, TICKETS_FK_NAME, 'NO ACTION');
  }

  const hasComments = await knex.schema.hasTable(COMMENTS_TABLE);
  if (hasComments) {
    await recreateOrgFk(knex, COMMENTS_TABLE, COMMENTS_FK_NAME, 'NO ACTION');
  }
}
