import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // 1. Drop the existing check constraint
  await knex.raw(`
    ALTER TABLE attendance_logs 
    DROP CONSTRAINT IF EXISTS attendance_logs_status_check;
  `);

  // 2. Add the new check constraint including 'NOT_CHECKED_IN' (HALF_DAY is deprecated but kept here
  // for historical compatibility; a later migration tightens this set further)
  await knex.raw(`
    ALTER TABLE attendance_logs 
    ADD CONSTRAINT attendance_logs_status_check 
    CHECK (status IN ('PRESENT', 'ABSENT', 'HALF_DAY', 'NOT_CHECKED_IN'));
  `);

  // 3. Set the default value to 'NOT_CHECKED_IN'
  await knex.schema.alterTable('attendance_logs', (table) => {
    table.string('status').defaultTo('NOT_CHECKED_IN').alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  // Revert default value to 'ABSENT'
  await knex.schema.alterTable('attendance_logs', (table) => {
    table.string('status').defaultTo('ABSENT').alter();
  });

  // Convert 'NOT_CHECKED_IN' records back to 'ABSENT' to satisfy the old constraint
  await knex('attendance_logs').where('status', 'NOT_CHECKED_IN').update({ status: 'ABSENT' });

  // Drop the new constraint
  await knex.raw(`
    ALTER TABLE attendance_logs 
    DROP CONSTRAINT IF EXISTS attendance_logs_status_check;
  `);

  // Restore the old constraint
  await knex.raw(`
    ALTER TABLE attendance_logs 
    ADD CONSTRAINT attendance_logs_status_check 
    CHECK (status IN ('PRESENT', 'ABSENT', 'HALF_DAY'));
  `);
}
