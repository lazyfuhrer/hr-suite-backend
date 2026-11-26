import bcrypt from 'bcrypt';
import type { Knex } from 'knex';

export async function seed(knex: Knex): Promise<void> {
  const email = 'admin@shloka.com';

  const existingAdmin = await knex('super_admins').where({ email }).first();
  if (existingAdmin) {
    return;
  }

  const password_hash = await bcrypt.hash('Admin@123', 10);

  await knex('super_admins').insert({
    email,
    full_name: 'Shloka SuperUser',
    password_hash,
  });
}
