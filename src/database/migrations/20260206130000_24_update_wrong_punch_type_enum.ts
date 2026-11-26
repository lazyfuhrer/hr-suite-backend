import type { Knex } from 'knex';

const TABLE = 'attendance_correction_requests';
const CONSTRAINT = 'attendance_correction_requests_wrong_punch_type_check';

export async function up(knex: Knex): Promise<void> {
  // The original migration created wrong_punch_type as a PostgreSQL ENUM type
  // We need to convert it to varchar with a CHECK constraint to allow both old and new values
  // Old values: MISSING_IN, MISSING_OUT, WRONG_IN, WRONG_OUT
  // New values: CLOCK_IN, CLOCK_OUT, BREAKS
  // Keep existing data unchanged - allow all values to coexist

  // Execute everything in a single DO block to ensure atomicity
  await knex.schema.raw(`
    DO $$ 
    DECLARE
      enum_type_name text;
    BEGIN
      -- Step 1: Drop any existing CHECK constraint
      ALTER TABLE "${TABLE}" DROP CONSTRAINT IF EXISTS "${CONSTRAINT}";
      
      -- Step 2: Get the column type
      SELECT udt_name INTO enum_type_name
      FROM information_schema.columns
      WHERE table_name = '${TABLE}' 
        AND column_name = 'wrong_punch_type';
      
      -- Step 3: If it's an ENUM type, convert to varchar
      IF enum_type_name IS NOT NULL AND enum_type_name LIKE '%enum%' THEN
        ALTER TABLE "${TABLE}" 
        ALTER COLUMN wrong_punch_type TYPE varchar(50) 
        USING wrong_punch_type::varchar;
      END IF;
      
      -- Step 4: Add CHECK constraint with all allowed values
      ALTER TABLE "${TABLE}" 
      ADD CONSTRAINT "${CONSTRAINT}" 
      CHECK (wrong_punch_type IN ('MISSING_IN','MISSING_OUT','WRONG_IN','WRONG_OUT','CLOCK_IN','CLOCK_OUT','BREAKS') OR wrong_punch_type IS NULL);
    END $$;
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Restore the previous constraint with only old values
  // Note: This will fail if there are rows with new enum values (CLOCK_IN, CLOCK_OUT, BREAKS)
  // Rollback should be done carefully after checking for new values
  await knex.schema.raw(`ALTER TABLE "${TABLE}" DROP CONSTRAINT IF EXISTS "${CONSTRAINT}"`);

  // Note: We don't convert back to ENUM in rollback as it's complex and may fail if new values exist
  // The column will remain as varchar, which is acceptable
}
