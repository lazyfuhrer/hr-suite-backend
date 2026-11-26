import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('attendance_logs', (table) => {
    table
      .integer('overtime_minutes')
      .nullable()
      .comment('Imported overtime minutes; used by read APIs when set');
    table.timestamp('imported_at', { useTz: true }).nullable();
    table
      .uuid('imported_by_user_id')
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('attendance_logs', (table) => {
    table.dropColumn('overtime_minutes');
    table.dropColumn('imported_at');
    table.dropColumn('imported_by_user_id');
  });
}
