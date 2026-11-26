import type { Knex } from 'knex';

const TABLE = 'users';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable(TABLE, (table) => {
    table.timestamp('employee_welcome_email_sent_at', { useTz: true }).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable(TABLE, (table) => {
    table.dropColumn('employee_welcome_email_sent_at');
  });
}
