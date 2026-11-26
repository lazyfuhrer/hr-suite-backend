import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('user_face_embeddings', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table
      .uuid('org_id')
      .notNullable()
      .references('id')
      .inTable('organizations')
      .onDelete('CASCADE');
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');

    table.string('provider', 20).notNullable().defaultTo('rekognition');
    table.text('rekognition_collection_id').notNullable();
    table.text('rekognition_face_id').notNullable().unique();

    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['org_id', 'user_id'], 'idx_user_face_embeddings_org_user');
    table.unique(['org_id', 'user_id'], 'uq_user_face_embeddings_org_user');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('user_face_embeddings');
}
