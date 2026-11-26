import type { Knex } from 'knex';

const TABLE = 'attendance_correction_requests';
const CONSTRAINT = 'attendance_correction_requests_wrong_punch_type_check';

export async function up(knex: Knex): Promise<void> {
  // Force fix the constraint - drop it completely and recreate with all values
  // This migration ensures the constraint allows both old and new enum values

  // Step 1: Drop the constraint if it exists
  await knex.schema.raw(`ALTER TABLE "${TABLE}" DROP CONSTRAINT IF EXISTS "${CONSTRAINT}"`);

  // Step 2: Ensure column is varchar (not ENUM)
  await knex.schema.raw(`
    DO $$ 
    BEGIN
      -- Check if column exists and is ENUM type
      IF EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public'
          AND table_name = '${TABLE}' 
          AND column_name = 'wrong_punch_type'
          AND (udt_name LIKE '%enum%' OR data_type = 'USER-DEFINED')
      ) THEN
        -- Convert ENUM to varchar
        ALTER TABLE "${TABLE}" 
        ALTER COLUMN wrong_punch_type TYPE varchar(50) 
        USING wrong_punch_type::varchar;
      END IF;
    EXCEPTION
      WHEN OTHERS THEN
        -- If conversion fails, column might already be varchar, continue
        NULL;
    END $$;
  `);

  // Step 3: Add the constraint with ALL allowed values (explicitly listed)
  await knex.schema.raw(`
    ALTER TABLE "${TABLE}" 
    ADD CONSTRAINT "${CONSTRAINT}" 
    CHECK (
      wrong_punch_type IS NULL 
      OR wrong_punch_type = 'MISSING_IN'
      OR wrong_punch_type = 'MISSING_OUT'
      OR wrong_punch_type = 'WRONG_IN'
      OR wrong_punch_type = 'WRONG_OUT'
      OR wrong_punch_type = 'CLOCK_IN'
      OR wrong_punch_type = 'CLOCK_OUT'
      OR wrong_punch_type = 'BREAKS'
    )
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.raw(`ALTER TABLE "${TABLE}" DROP CONSTRAINT IF EXISTS "${CONSTRAINT}"`);
}
