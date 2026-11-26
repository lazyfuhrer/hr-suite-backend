import type { Knex } from 'knex';

const TABLE = 'user_documents';
const COLUMN = 'file_key';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE "${TABLE}" ALTER COLUMN "${COLUMN}" TYPE text`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(
    `ALTER TABLE "${TABLE}" ALTER COLUMN "${COLUMN}" TYPE varchar(255) USING left("${COLUMN}", 255)`,
  );
}
