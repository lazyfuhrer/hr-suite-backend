import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('department_managers', (table) => {
    table
      .uuid('department_id')
      .notNullable()
      .references('id')
      .inTable('departments')
      .onDelete('CASCADE');
    table.uuid('manager_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.primary(['department_id', 'manager_id']);
  });

  // Backfill existing single manager assignments.
  await knex.raw(`
    INSERT INTO department_managers (department_id, manager_id, created_at)
    SELECT id, manager_id, NOW()
    FROM departments
    WHERE manager_id IS NOT NULL
    ON CONFLICT (department_id, manager_id) DO NOTHING
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('department_managers');
}
