import type { Knex } from 'knex';

const USERS_TABLE = 'users';
const ONBOARDINGS_TABLE = 'user_onboardings';
const IDENTITIES_TABLE = 'user_identities';

export async function up(knex: Knex): Promise<void> {
  const [hasUsers, hasOnboardings, hasIdentities] = await Promise.all([
    knex.schema.hasTable(USERS_TABLE),
    knex.schema.hasTable(ONBOARDINGS_TABLE),
    knex.schema.hasTable(IDENTITIES_TABLE),
  ]);

  if (!hasUsers || !hasOnboardings || !hasIdentities) return;

  // Fix only clearly premature rejection cases:
  // - user looks like an invited user (must_change_password=true, employee_id is null)
  // - onboarding not completed yet
  // - rejected with failed/in-progress/pending KYC
  // - Aadhaar or PAN identity is still missing
  //
  // This avoids touching genuinely completed users who were rejected after real checks.
  await knex.raw(`
    WITH identity_flags AS (
      SELECT
        ui.user_id,
        BOOL_OR(
          ui.id_type IN ('AADHAR', 'AADHAAR')
          AND ui.id_number IS NOT NULL
          AND BTRIM(ui.id_number) <> ''
        ) AS has_aadhaar,
        BOOL_OR(
          ui.id_type = 'PAN'
          AND ui.id_number IS NOT NULL
          AND BTRIM(ui.id_number) <> ''
        ) AS has_pan
      FROM ${IDENTITIES_TABLE} ui
      GROUP BY ui.user_id
    ),
    affected AS (
      SELECT u.id
      FROM ${USERS_TABLE} u
      LEFT JOIN ${ONBOARDINGS_TABLE} uo ON uo.user_id = u.id
      LEFT JOIN identity_flags f ON f.user_id = u.id
      WHERE u.status = 'REJECTED'
        AND COALESCE(u.must_change_password, FALSE) = TRUE
        AND u.employee_id IS NULL
        AND (uo.onboarding_status IS NULL OR uo.onboarding_status <> 'COMPLETED')
        AND COALESCE(uo.kyc_status, 'PENDING') IN ('FAILED', 'IN_PROGRESS', 'PENDING')
        AND (COALESCE(f.has_aadhaar, FALSE) = FALSE OR COALESCE(f.has_pan, FALSE) = FALSE)
    )
    UPDATE ${USERS_TABLE}
    SET status = 'INVITED',
        updated_at = NOW()
    WHERE id IN (SELECT id FROM affected)
  `);

  await knex.raw(`
    WITH identity_flags AS (
      SELECT
        ui.user_id,
        BOOL_OR(
          ui.id_type IN ('AADHAR', 'AADHAAR')
          AND ui.id_number IS NOT NULL
          AND BTRIM(ui.id_number) <> ''
        ) AS has_aadhaar,
        BOOL_OR(
          ui.id_type = 'PAN'
          AND ui.id_number IS NOT NULL
          AND BTRIM(ui.id_number) <> ''
        ) AS has_pan
      FROM ${IDENTITIES_TABLE} ui
      GROUP BY ui.user_id
    ),
    affected AS (
      SELECT u.id
      FROM ${USERS_TABLE} u
      LEFT JOIN ${ONBOARDINGS_TABLE} uo ON uo.user_id = u.id
      LEFT JOIN identity_flags f ON f.user_id = u.id
      WHERE COALESCE(u.must_change_password, FALSE) = TRUE
        AND u.employee_id IS NULL
        AND (uo.onboarding_status IS NULL OR uo.onboarding_status <> 'COMPLETED')
        AND u.status = 'INVITED'
        AND COALESCE(uo.kyc_status, 'PENDING') IN ('FAILED', 'IN_PROGRESS', 'PENDING')
        AND (COALESCE(f.has_aadhaar, FALSE) = FALSE OR COALESCE(f.has_pan, FALSE) = FALSE)
    )
    UPDATE ${ONBOARDINGS_TABLE}
    SET kyc_status = 'PENDING',
        kyc_failure_reason = NULL,
        kyc_checked_at = NULL,
        updated_at = NOW()
    WHERE user_id IN (SELECT id FROM affected)
  `);
}

export async function down(): Promise<void> {
  // Intentionally no-op.
  // This migration performs a data correction and is not safely reversible.
}
