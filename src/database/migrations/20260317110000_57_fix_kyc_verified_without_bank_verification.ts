import type { Knex } from 'knex';

const USERS_TABLE = 'users';
const ONBOARDINGS_TABLE = 'user_onboardings';
const BANK_TABLE = 'bank_details';

export async function up(knex: Knex): Promise<void> {
  // Fix inconsistent rows introduced before bank-verification gating:
  // if onboarding KYC is VERIFIED but bank verification is not VERIFIED,
  // move KYC back to PENDING and user status back from ACTIVE.
  await knex.transaction(async (trx) => {
    await trx.raw(
      `
      UPDATE ${ONBOARDINGS_TABLE} uo
      SET
        kyc_status = 'PENDING',
        kyc_failure_reason = 'Waiting for bank account verification',
        kyc_checked_at = NOW()
      FROM ${USERS_TABLE} u
      LEFT JOIN ${BANK_TABLE} bd ON bd.user_id = u.id
      WHERE
        u.id = uo.user_id
        AND uo.kyc_status = 'VERIFIED'
        AND COALESCE(bd.verification_status, 'PENDING') <> 'VERIFIED'
      `,
    );

    await trx.raw(
      `
      UPDATE ${USERS_TABLE} u
      SET status = CASE
        WHEN COALESCE(uo.onboarding_status, 'IN_PROGRESS') = 'COMPLETED' THEN 'IN_PROGRESS'
        ELSE 'INVITED'
      END
      FROM ${ONBOARDINGS_TABLE} uo
      WHERE
        u.id = uo.user_id
        AND u.status = 'ACTIVE'
        AND uo.kyc_status = 'PENDING'
        AND COALESCE(
          (
            SELECT bd.verification_status
            FROM ${BANK_TABLE} bd
            WHERE bd.user_id = u.id
            LIMIT 1
          ),
          'PENDING'
        ) <> 'VERIFIED'
      `,
    );
  });
}

export async function down(_knex: Knex): Promise<void> {
  // No down migration for data correction.
}
