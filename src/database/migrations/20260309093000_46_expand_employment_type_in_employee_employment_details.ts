import type { Knex } from 'knex';

const CONSTRAINT_NAME = 'employee_employment_details_employment_type_check';

export async function up(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable('employee_employment_details');
  if (!hasTable) return;

  await knex.raw(
    `ALTER TABLE "employee_employment_details" DROP CONSTRAINT IF EXISTS "${CONSTRAINT_NAME}"`,
  );
  await knex.raw(`
    ALTER TABLE "employee_employment_details"
    ADD CONSTRAINT "${CONSTRAINT_NAME}"
    CHECK (
      employment_type = ANY (
        ARRAY[
          'FULL_TIME'::text,
          'PART_TIME'::text,
          'CONTRACT'::text,
          'INTERN'::text,
          'INTERNSHIP'::text,
          'FREELANCE'::text
        ]
      )
    )
  `);
}

export async function down(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable('employee_employment_details');
  if (!hasTable) return;

  await knex.raw(
    `ALTER TABLE "employee_employment_details" DROP CONSTRAINT IF EXISTS "${CONSTRAINT_NAME}"`,
  );
  await knex.raw(`
    ALTER TABLE "employee_employment_details"
    ADD CONSTRAINT "${CONSTRAINT_NAME}"
    CHECK (
      employment_type = ANY (
        ARRAY[
          'FULL_TIME'::text,
          'PART_TIME'::text,
          'CONTRACT'::text,
          'INTERN'::text
        ]
      )
    )
  `);
}
