import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const columnCheck = await knex.raw(
    `
    select exists(
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'user_face_embeddings'
        and column_name = 'provider'
    ) as column_exists
  `,
  );

  const columnExists = Boolean((columnCheck as any)?.rows?.[0]?.column_exists);

  if (!columnExists) {
    await knex.schema.alterTable('user_face_embeddings', (table) => {
      table.string('provider', 20).notNullable().defaultTo('rekognition');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user_face_embeddings', (table) => {
    table.dropColumn('provider');
  });
}
