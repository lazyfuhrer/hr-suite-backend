import type { Knex } from 'knex';

export async function seed(knex: Knex): Promise<void> {
  const orgs = await knex('organizations').select('id');

  for (const org of orgs) {
    const existingLocation = await knex('office_locations')
      .where({ org_id: org.id, name: 'Headquarters' })
      .first();

    if (!existingLocation) {
      await knex('office_locations').insert({
        org_id: org.id,
        name: 'Headquarters',
        latitude: 22.5726,
        longitude: 88.3639,
        radius_meters: 100,
      });
    }

    const existingShift = await knex('work_shifts')
      .where({ org_id: org.id, name: 'General Shift' })
      .first();

    if (!existingShift) {
      await knex('work_shifts').insert({
        org_id: org.id,
        name: 'General Shift',
        start_time: '09:00:00',
        end_time: '18:00:00',
        break_start_time: '13:00:00',
        break_end_time: '14:00:00',
        break_duration_mins: 60,
      });
    }
  }
}
