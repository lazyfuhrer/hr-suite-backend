import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const colCheck = await knex.raw(
    `
    select exists(
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'user_face_embeddings'
        and column_name = 'embedding'
    ) as embedding_exists
  `,
  );

  const embeddingExists = Boolean((colCheck as any)?.rows?.[0]?.embedding_exists);

  if (!embeddingExists) {
    // If embedding column was removed earlier, skip this constraint change.
    return;
  }

  // The existing column "embedding" is a USER-DEFINED type (likely pgvector).
  // We only want to relax the NOT NULL constraint for now so Rekognition-only
  // rows can be stored without an embedding.
  await knex.raw('ALTER TABLE "user_face_embeddings" ALTER COLUMN "embedding" DROP NOT NULL');
}

export async function down(knex: Knex): Promise<void> {
  const colCheck = await knex.raw(
    `
    select exists(
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'user_face_embeddings'
        and column_name = 'embedding'
    ) as embedding_exists
  `,
  );

  const embeddingExists = Boolean((colCheck as any)?.rows?.[0]?.embedding_exists);

  if (!embeddingExists) return;

  // Best-effort rollback to restore the NOT NULL constraint.
  await knex.raw('ALTER TABLE "user_face_embeddings" ALTER COLUMN "embedding" SET NOT NULL');
}
