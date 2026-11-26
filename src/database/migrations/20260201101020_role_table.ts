import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('roles', (table) => {
    table.string('id').primary();
    table.string('name').notNullable().unique();
    table.string('description').notNullable().unique();
  });

  await knex('roles').insert([
    {
      id: 'f000000000000-000000000000-0',
      name: 'super admin',
      description: 'Ultimate system authority and organization owner',
    },
    {
      id: 'f000000000000-000000000000-1',
      name: 'admin',
      description: 'Organization Head with full system access',
    },
    {
      id: 'f000000000000-000000000000-2',
      name: 'hr',
      description: 'Human Resources manager responsible for personnel and recruitment',
    },
    {
      id: 'f000000000000-000000000000-3',
      name: 'manager',
      description: 'Team lead operating under the organization head',
    },
    {
      id: 'f000000000000-000000000000-4',
      name: 'employee',
      description: 'Standard staff member with basic access rights',
    },
    {
      id: 'f000000000000-000000000000-5',
      name: 'sales',
      description: 'Sales department representative reporting to Super Admin',
    },
    {
      id: 'f000000000000-000000000000-6',
      name: 'support',
      description: 'Customer support specialist reporting to Super Admin',
    },
  ]);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('roles');
}
