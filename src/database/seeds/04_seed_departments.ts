import type { Knex } from 'knex';

export async function seed(knex: Knex): Promise<void> {
  // Default department names to create for each organization
  const defaultDepartments = ['Human Resources', 'Engineering', 'Sales', 'Finance', 'Operations'];

  const orgs = await knex('organizations').select('id');

  for (const org of orgs) {
    // Ensure default departments exist for this org
    const existingDepartments = await knex('departments')
      .where('org_id', org.id)
      .whereIn('name', defaultDepartments)
      .select('name');

    const existingNames = new Set(existingDepartments.map((d: { name: string }) => d.name));

    const departmentsToInsert = defaultDepartments
      .filter((name) => !existingNames.has(name))
      .map((name) => ({
        org_id: org.id,
        name,
      }));

    if (departmentsToInsert.length > 0) {
      await knex('departments').insert(departmentsToInsert);
    }

    // Find the default office location and work shift for this org
    const location = await knex('office_locations')
      .where({ org_id: org.id, name: 'Headquarters' })
      .first('id');

    const shift = await knex('work_shifts')
      .where({ org_id: org.id, name: 'General Shift' })
      .first('id');

    // If both exist, attach them to departments that don't have a location/shift yet
    if (location && shift) {
      await knex('departments')
        .where('org_id', org.id)
        .andWhere(function () {
          this.whereNull('location_id').orWhereNull('default_shift_id');
        })
        .update({
          location_id: location.id,
          default_shift_id: shift.id,
        });
    }
  }
}
