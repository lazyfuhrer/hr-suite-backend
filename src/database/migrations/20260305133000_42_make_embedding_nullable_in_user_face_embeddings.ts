import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user_face_embeddings', () => {
    // Knex doesn't have a portable API to drop NOT NULL, so use raw SQL.
    return knex.raw('ALTER TABLE "user_face_embeddings" ALTER COLUMN "embedding" DROP NOT NULL');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user_face_embeddings', () => {
    // Best-effort rollback to restore NOT NULL constraint.
    return knex.raw('ALTER TABLE "user_face_embeddings" ALTER COLUMN "embedding" SET NOT NULL');
  });
}
