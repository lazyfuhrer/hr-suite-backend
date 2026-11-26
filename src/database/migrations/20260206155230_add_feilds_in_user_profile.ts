import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  return knex.schema.alterTable('user_profiles', (table) => {
    table.string('blood_group').nullable();
    table.string('emergency_contact_name').nullable();
    table.string('emergency_contact_phone').nullable();
    table.text('permanent_address').nullable();
    table.text('present_address').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  return knex.schema.alterTable('user_profiles', (table) => {
    (table.dropColumn('blood_group'),
      table.dropColumn('emergency_contact_name'),
      table.dropColumn('emergency_contact_phone'),
      table.dropColumn('permanent_address'),
      table.dropColumn('present_address'));
  });
}
