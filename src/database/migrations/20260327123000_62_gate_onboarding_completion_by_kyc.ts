import type { Knex } from 'knex';

const TABLE = 'user_onboardings';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    UPDATE "${TABLE}" uo
    SET
      onboarding_status = 'IN_PROGRESS',
      completed_at = NULL
    WHERE uo.onboarding_status = 'COMPLETED'
      AND (
        COALESCE(uo.kyc_status, 'PENDING') <> 'VERIFIED'
        OR NOT EXISTS (
          SELECT 1
          FROM user_documents ud
          INNER JOIN users uploader ON uploader.id = ud.uploaded_by
          INNER JOIN users owner ON owner.id = uo.user_id
          WHERE ud.user_id = uo.user_id
            AND uploader.role IN ('admin', 'hr')
            AND uploader.org_id = owner.org_id
        )
      );
  `);

  await knex.raw(`
    UPDATE "${TABLE}" uo
    SET
      onboarding_status = 'COMPLETED',
      completed_at = COALESCE(uo.completed_at, NOW())
    WHERE uo.onboarding_status = 'IN_PROGRESS'
      AND uo.kyc_status = 'VERIFIED'
      AND COALESCE(uo.offer_letter_signed, FALSE) = TRUE
      AND uo.offer_letter_url IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM user_documents ud
        INNER JOIN users uploader ON uploader.id = ud.uploaded_by
        INNER JOIN users owner ON owner.id = uo.user_id
        WHERE ud.user_id = uo.user_id
          AND uploader.role IN ('admin', 'hr')
          AND uploader.org_id = owner.org_id
      );
  `);
}

export async function down(_knex: Knex): Promise<void> {
  // No-op rollback: prior data could have been inconsistent by design.
}
