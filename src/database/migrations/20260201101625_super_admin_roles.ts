import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('super_admins_roles', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('super_admin_id')
      .notNullable()
      .references('id')
      .inTable('super_admins')
      .onDelete('CASCADE');
    table.string('role_id').notNullable().references('id').inTable('roles').onDelete('CASCADE');

    table.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('super_admins_roles');
}
