import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Convert existing HALF_DAY records to PRESENT so status remains valid
  await knex('attendance_logs').where('status', 'HALF_DAY').update({ status: 'PRESENT' });

  // Update the check constraint on status to remove HALF_DAY
  await knex.raw(`
    ALTER TABLE attendance_logs
    DROP CONSTRAINT IF EXISTS attendance_logs_status_check;
  `);

  await knex.raw(`
    ALTER TABLE attendance_logs
    ADD CONSTRAINT attendance_logs_status_check
    CHECK (status IN ('PRESENT', 'ABSENT', 'NOT_CHECKED_IN'));
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Restore the previous constraint that allowed HALF_DAY again
  await knex.raw(`
    ALTER TABLE attendance_logs
    DROP CONSTRAINT IF EXISTS attendance_logs_status_check;
  `);

  await knex.raw(`
    ALTER TABLE attendance_logs
    ADD CONSTRAINT attendance_logs_status_check
    CHECK (status IN ('PRESENT', 'ABSENT', 'HALF_DAY', 'NOT_CHECKED_IN'));
  `);
}
