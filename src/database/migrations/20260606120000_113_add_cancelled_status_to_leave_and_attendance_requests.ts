import type { Knex } from 'knex';

const LEAVE_STATUS_CHECK = 'leave_requests_status_check';
const ATTENDANCE_STATUS_CHECK = 'attendance_correction_requests_status_check';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.raw(
    `ALTER TABLE "leave_requests" DROP CONSTRAINT IF EXISTS "${LEAVE_STATUS_CHECK}"`,
  );
  await knex.schema.raw(
    `ALTER TABLE "leave_requests" ADD CONSTRAINT "${LEAVE_STATUS_CHECK}" CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED'))`,
  );

  await knex.schema.alterTable('leave_requests', (table) => {
    table.timestamp('cancelled_at', { useTz: true }).nullable();
    table.uuid('cancelled_by').nullable().references('id').inTable('users').onDelete('SET NULL');
  });

  await knex.schema.raw(
    `ALTER TABLE "attendance_correction_requests" DROP CONSTRAINT IF EXISTS "${ATTENDANCE_STATUS_CHECK}"`,
  );
  await knex.schema.raw(
    `ALTER TABLE "attendance_correction_requests" ADD CONSTRAINT "${ATTENDANCE_STATUS_CHECK}" CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED'))`,
  );

  await knex.schema.alterTable('attendance_correction_requests', (table) => {
    table.timestamp('cancelled_at', { useTz: true }).nullable();
    table.uuid('cancelled_by').nullable().references('id').inTable('users').onDelete('SET NULL');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex('leave_requests').where('status', 'CANCELLED').delete();
  await knex('attendance_correction_requests').where('status', 'CANCELLED').delete();

  await knex.schema.alterTable('leave_requests', (table) => {
    table.dropColumn('cancelled_by');
    table.dropColumn('cancelled_at');
  });
  await knex.schema.raw(
    `ALTER TABLE "leave_requests" DROP CONSTRAINT IF EXISTS "${LEAVE_STATUS_CHECK}"`,
  );
  await knex.schema.raw(
    `ALTER TABLE "leave_requests" ADD CONSTRAINT "${LEAVE_STATUS_CHECK}" CHECK (status IN ('PENDING','APPROVED','REJECTED'))`,
  );

  await knex.schema.alterTable('attendance_correction_requests', (table) => {
    table.dropColumn('cancelled_by');
    table.dropColumn('cancelled_at');
  });
  await knex.schema.raw(
    `ALTER TABLE "attendance_correction_requests" DROP CONSTRAINT IF EXISTS "${ATTENDANCE_STATUS_CHECK}"`,
  );
  await knex.schema.raw(
    `ALTER TABLE "attendance_correction_requests" ADD CONSTRAINT "${ATTENDANCE_STATUS_CHECK}" CHECK (status IN ('PENDING','APPROVED','REJECTED'))`,
  );
}
