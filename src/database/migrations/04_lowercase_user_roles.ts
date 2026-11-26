import type { Knex } from 'knex';

const ROLE_VALUES = ['admin', 'hr', 'manager', 'employee'] as const;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.raw('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check');
  await knex('users').update({ role: knex.raw('LOWER(role)') });

  await knex.schema.raw(
    `ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('${ROLE_VALUES.join("','")}'))`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.raw('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check');

  await knex.schema.raw(
    "ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('ADMIN','HR','MANAGER','EMPLOYEE'))",
  );
}
