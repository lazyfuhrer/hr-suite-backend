import type { Knex } from 'knex';

const DEVICE_ROLE_ID = 'f000000000000-000000000000-7';

export async function up(knex: Knex): Promise<void> {
  // 1) Add role record (id format matches existing seeded roles)
  await knex('roles')
    .insert({
      id: DEVICE_ROLE_ID,
      name: 'device',
      description: 'Device account used for in-office hardware integrations',
    })
    .onConflict('name')
    .ignore();

  // 2) Extend users.role check constraint to include 'device'
  await knex.raw('ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_role_check"');
  await knex.raw(`
    ALTER TABLE "users"
    ADD CONSTRAINT "users_role_check"
    CHECK (
      role = ANY (ARRAY[
        'admin'::text,
        'hr'::text,
        'manager'::text,
        'employee'::text,
        'device'::text
      ])
    )
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Revert users with role=device so the older constraint can be re-applied.
  await knex('users').where({ role: 'device' }).update({ role: 'employee' });

  await knex.raw('ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_role_check"');
  await knex.raw(`
    ALTER TABLE "users"
    ADD CONSTRAINT "users_role_check"
    CHECK (
      role = ANY (ARRAY[
        'admin'::text,
        'hr'::text,
        'manager'::text,
        'employee'::text
      ])
    )
  `);

  await knex('roles').where({ id: DEVICE_ROLE_ID }).delete();
}
