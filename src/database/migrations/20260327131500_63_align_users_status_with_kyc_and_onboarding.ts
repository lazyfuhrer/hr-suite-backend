import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    UPDATE users u
    SET status = 'IN_PROGRESS'
    FROM user_onboardings uo
    WHERE u.id = uo.user_id
      AND u.deleted_at IS NULL
      AND COALESCE(uo.kyc_status, 'PENDING') <> 'VERIFIED';
  `);

  await knex.raw(`
    UPDATE users u
    SET status = 'ACTIVE'
    FROM user_onboardings uo
    WHERE u.id = uo.user_id
      AND u.deleted_at IS NULL
      AND uo.kyc_status = 'VERIFIED'
      AND uo.onboarding_status = 'COMPLETED';
  `);
}

export async function down(_knex: Knex): Promise<void> {
  // No-op rollback.
}
