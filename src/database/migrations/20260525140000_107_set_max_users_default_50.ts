import type { Knex } from 'knex';

const PREVIOUS_DEFAULT_MAX_USERS = 100;
const NEW_DEFAULT_MAX_USERS = 50;

export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    `ALTER TABLE organizations ALTER COLUMN max_users SET DEFAULT ${NEW_DEFAULT_MAX_USERS}`,
  );

  await knex('organizations')
    .where('max_users', PREVIOUS_DEFAULT_MAX_USERS)
    .update({ max_users: NEW_DEFAULT_MAX_USERS });
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(
    `ALTER TABLE organizations ALTER COLUMN max_users SET DEFAULT ${PREVIOUS_DEFAULT_MAX_USERS}`,
  );

  await knex('organizations')
    .where('max_users', NEW_DEFAULT_MAX_USERS)
    .update({ max_users: PREVIOUS_DEFAULT_MAX_USERS });
}
