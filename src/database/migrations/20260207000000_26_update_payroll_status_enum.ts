import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Drop existing constraint
  await knex.schema.raw(
    'ALTER TABLE "payroll_records" DROP CONSTRAINT IF EXISTS "payroll_records_status_check"',
  );

  // Add new constraint with updated enum values (including PENDING and ADJUSTED)
  await knex.schema.raw(
    `ALTER TABLE "payroll_records" ADD CONSTRAINT "payroll_records_status_check" CHECK (status IN ('PENDING','ADJUSTED','PAID','DRAFT','PROCESSED','CANCELLED'))`,
  );

  // Update existing DRAFT records to PENDING
  await knex('payroll_records').where('status', 'DRAFT').update({ status: 'PENDING' });

  // Update existing PROCESSED records to ADJUSTED (if they haven't been paid)
  await knex('payroll_records')
    .where('status', 'PROCESSED')
    .whereNull('paid_at')
    .update({ status: 'ADJUSTED' });
}

export async function down(knex: Knex): Promise<void> {
  // Revert ADJUSTED back to PROCESSED
  await knex('payroll_records').where('status', 'ADJUSTED').update({ status: 'PROCESSED' });

  // Revert PENDING back to DRAFT
  await knex('payroll_records').where('status', 'PENDING').update({ status: 'DRAFT' });

  // Drop new constraint
  await knex.schema.raw(
    'ALTER TABLE "payroll_records" DROP CONSTRAINT IF EXISTS "payroll_records_status_check"',
  );

  // Restore original constraint
  await knex.schema.raw(
    "ALTER TABLE \"payroll_records\" ADD CONSTRAINT \"payroll_records_status_check\" CHECK (status IN ('DRAFT','PROCESSED','PAID','CANCELLED'))",
  );
}
