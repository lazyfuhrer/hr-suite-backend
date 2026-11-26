import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // 1) Normalize any old late-arrival style statuses to LATE
  // If you previously stored 'LATE_ARRIVAL' in attendance_logs.status (or similar), convert them.
  await knex('attendance_logs').where('status', 'LATE_ARRIVAL').update({ status: 'LATE' });

  // 2) Normalize any old leave statuses to LEAVE
  // If you had 'ON_LEAVE' persisted anywhere, convert it to 'LEAVE'.
  await knex('attendance_logs').where('status', 'ON_LEAVE').update({ status: 'LEAVE' });

  // If you have other tables where these statuses were stored, repeat the pattern, e.g.:
  // await knex('some_other_table')
  //   .where('status', 'LATE_ARRIVAL')
  //   .update({ status: 'LATE' });
  //
  // await knex('some_other_table')
  //   .where('status', 'ON_LEAVE')
  //   .update({ status: 'LEAVE' });
}

export async function down(knex: Knex): Promise<void> {
  // Best-effort rollback to old values (optional)
  await knex('attendance_logs').where('status', 'LATE').update({ status: 'LATE_ARRIVAL' });

  await knex('attendance_logs').where('status', 'LEAVE').update({ status: 'ON_LEAVE' });
}
