import type { Knex } from 'knex';

const USERS_TABLE = 'users';
const ONBOARDINGS_TABLE = 'user_onboardings';

export async function up(knex: Knex): Promise<void> {
  const [hasUsers, hasOnboardings] = await Promise.all([
    knex.schema.hasTable(USERS_TABLE),
    knex.schema.hasTable(ONBOARDINGS_TABLE),
  ]);

  if (!hasUsers || !hasOnboardings) return;

  const [hasKycStatus, hasKycFailureReason, hasKycCheckedAt, hasKycProvider, hasUpdatedAt] =
    await Promise.all([
      knex.schema.hasColumn(ONBOARDINGS_TABLE, 'kyc_status'),
      knex.schema.hasColumn(ONBOARDINGS_TABLE, 'kyc_failure_reason'),
      knex.schema.hasColumn(ONBOARDINGS_TABLE, 'kyc_checked_at'),
      knex.schema.hasColumn(ONBOARDINGS_TABLE, 'kyc_provider'),
      knex.schema.hasColumn(ONBOARDINGS_TABLE, 'updated_at'),
    ]);

  if (!hasKycStatus) return;

  await knex.transaction(async (trx) => {
    // Ensure existing users have onboarding rows so KYC can be backfilled consistently.
    await trx.raw(`
      INSERT INTO ${ONBOARDINGS_TABLE} (
        user_id,
        asset_agreement_accepted,
        policy_acknowledged,
        offer_letter_signed,
        onboarding_status,
        created_at,
        updated_at
      )
      SELECT
        u.id,
        FALSE,
        FALSE,
        FALSE,
        'IN_PROGRESS',
        NOW(),
        NOW()
      FROM ${USERS_TABLE} u
      LEFT JOIN ${ONBOARDINGS_TABLE} uo ON uo.user_id = u.id
      WHERE uo.user_id IS NULL
        AND COALESCE(u.role, '') <> 'device'
    `);

    const patchData: Record<string, unknown> = {
      kyc_status: 'VERIFIED',
    };

    if (hasKycFailureReason) patchData.kyc_failure_reason = null;
    if (hasKycCheckedAt) patchData.kyc_checked_at = trx.fn.now();
    if (hasKycProvider) patchData.kyc_provider = 'SYSTEM_BACKFILL';
    if (hasUpdatedAt) patchData.updated_at = trx.fn.now();

    await trx(ONBOARDINGS_TABLE)
      .whereIn('user_id', trx(USERS_TABLE).select('id').whereNot('role', 'device'))
      .update(patchData);
  });
}

export async function down(_knex: Knex): Promise<void> {
  // Intentionally no-op: this is a one-way data backfill.
}
