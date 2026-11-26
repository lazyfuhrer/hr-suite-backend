import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('users_roles', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    table
      .string('role_id')

      .references('id')

      .inTable('roles')

      .onDelete('CASCADE');

    table
      .uuid('user_id')

      .notNullable()

      .references('id')

      .inTable('users')

      .onDelete('CASCADE');

    table.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('users_roles');
}
