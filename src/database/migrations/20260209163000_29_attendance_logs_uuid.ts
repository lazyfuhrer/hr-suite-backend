import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // 1) Drop foreign keys that reference attendance_logs.id
  await knex.schema.alterTable('attendance_breaks', (table) => {
    table.dropForeign(['attendance_log_id']);
  });

  await knex.schema.alterTable('attendance_correction_requests', (table) => {
    table.dropForeign(['attendance_log_id']);
  });

  // 2) Clear dependent data / references to avoid type conversion issues
  await knex('attendance_breaks').del();
  await knex('attendance_correction_requests').update({ attendance_log_id: null });

  // 3) Change attendance_logs.id from bigint to uuid with uuid_generate_v4()
  await knex.schema.raw(`
    ALTER TABLE "attendance_logs"
    ALTER COLUMN "id" DROP DEFAULT;
  `);

  await knex.schema.raw(`
    ALTER TABLE "attendance_logs"
    ALTER COLUMN "id" TYPE uuid USING uuid_generate_v4();
  `);

  await knex.schema.raw(`
    ALTER TABLE "attendance_logs"
    ALTER COLUMN "id" SET DEFAULT uuid_generate_v4();
  `);

  // 4) Change foreign key columns to uuid.
  //    We drop and recreate the columns to avoid casting bigint -> uuid.
  await knex.schema.alterTable('attendance_breaks', (table) => {
    table.dropColumn('attendance_log_id');
  });
  await knex.schema.alterTable('attendance_breaks', (table) => {
    table.uuid('attendance_log_id').notNullable();
  });

  await knex.schema.alterTable('attendance_correction_requests', (table) => {
    table.dropColumn('attendance_log_id');
  });
  await knex.schema.alterTable('attendance_correction_requests', (table) => {
    table.uuid('attendance_log_id').nullable();
  });

  // 5) Re-add foreign key constraints pointing to the new uuid PK
  await knex.schema.alterTable('attendance_breaks', (table) => {
    table
      .foreign('attendance_log_id')
      .references('id')
      .inTable('attendance_logs')
      .onDelete('CASCADE');
  });

  await knex.schema.alterTable('attendance_correction_requests', (table) => {
    table
      .foreign('attendance_log_id')
      .references('id')
      .inTable('attendance_logs')
      .onDelete('SET NULL');
  });
}

// NOTE: Down migration is intentionally a no-op because converting UUID primary keys
// back to bigint safely (with all references) is non-trivial and not required
// for normal development/production flows.
export async function down(): Promise<void> {
  // No automatic rollback – manual intervention required if needed.
}
