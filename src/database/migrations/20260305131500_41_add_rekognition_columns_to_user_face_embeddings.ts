import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const colCheck = await knex.raw(
    `
    select
      exists(
        select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'user_face_embeddings'
          and column_name = 'rekognition_collection_id'
      ) as collection_exists,
      exists(
        select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'user_face_embeddings'
          and column_name = 'rekognition_face_id'
      ) as face_exists
  `,
  );

  const collectionExists = Boolean((colCheck as any)?.rows?.[0]?.collection_exists);
  const faceExists = Boolean((colCheck as any)?.rows?.[0]?.face_exists);

  await knex.schema.alterTable('user_face_embeddings', (table) => {
    // Add Rekognition-specific columns only if missing (idempotent migration)
    if (!collectionExists) table.text('rekognition_collection_id');
    if (!faceExists) table.text('rekognition_face_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user_face_embeddings', (table) => {
    table.dropColumn('rekognition_collection_id');
    table.dropColumn('rekognition_face_id');
  });
}
