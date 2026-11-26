import bcrypt from 'bcrypt';
import type { Knex } from 'knex';

export async function seed(knex: Knex): Promise<void> {
  // 1) Create or fetch a demo organization
  const demoCompanyCode = 'DEMO001';

  let org = await knex('organizations').where({ company_code: demoCompanyCode }).first();

  if (!org) {
    const inserted = await knex('organizations')
      .insert({
        name: 'Demo Organization',
        company_code: demoCompanyCode,
        contact_email: 'contact+demo@shloka.local',
        subscription_status: 'ACTIVE',
      })
      .returning(['id', 'name', 'company_code', 'contact_email']);

    org = inserted[0];
  }

  const orgId = org.id;

  // 2) Ensure default office location for this org
  let location = await knex('office_locations')
    .where({ org_id: orgId, name: 'Headquarters' })
    .first();

  if (!location) {
    const insertedLocation = await knex('office_locations')
      .insert({
        org_id: orgId,
        name: 'Headquarters',
        latitude: 22.5726,
        longitude: 88.3639,
        radius_meters: 100,
      })
      .returning(['id']);

    location = insertedLocation[0];
  }

  // 3) Ensure default work shift for this org
  let shift = await knex('work_shifts').where({ org_id: orgId, name: 'General Shift' }).first();

  if (!shift) {
    const insertedShift = await knex('work_shifts')
      .insert({
        org_id: orgId,
        name: 'General Shift',
        start_time: '09:00:00',
        end_time: '18:00:00',
        break_start_time: '13:00:00',
        break_end_time: '14:00:00',
        break_duration_mins: 60,
      })
      .returning(['id']);

    shift = insertedShift[0];
  }

  // 4) Ensure at least one department wired to the location & shift
  const departmentName = 'Engineering';
  let department = await knex('departments').where({ org_id: orgId, name: departmentName }).first();

  if (!department) {
    const insertedDept = await knex('departments')
      .insert({
        org_id: orgId,
        name: departmentName,
        location_id: location.id,
        default_shift_id: shift.id,
      })
      .returning(['id', 'location_id', 'default_shift_id']);

    department = insertedDept[0];
  } else if (!department.location_id || !department.default_shift_id) {
    const updatedDept = await knex('departments')
      .where({ id: department.id })
      .update({
        location_id: department.location_id ?? location.id,
        default_shift_id: department.default_shift_id ?? shift.id,
      })
      .returning(['id', 'location_id', 'default_shift_id']);

    department = updatedDept[0];
  }

  // 5) Ensure an org admin user for this demo org
  const adminEmail = 'admin.demo@shloka.local';
  const adminPlainPassword = 'Admin@123';

  let adminUser = await knex('users').where({ org_id: orgId, official_email: adminEmail }).first();

  if (!adminUser) {
    const password_hash = await bcrypt.hash(adminPlainPassword, 10);

    const insertedAdmin = await knex('users')
      .insert({
        org_id: orgId,
        employee_id: 'ADMIN-01',
        first_name: 'Demo',
        last_name: 'Admin',
        official_email: adminEmail,
        password_hash,
        role: 'admin',
        status: 'ACTIVE',
        must_change_password: false,
      })
      .returning(['id']);

    adminUser = insertedAdmin[0];
  }

  // 6) Ensure an employee user with completed onboarding for this demo org
  const employeeEmail = 'employee.demo@shloka.local';
  const employeePlainPassword = 'Employee@123';

  let employeeUser = await knex('users')
    .where({ org_id: orgId, official_email: employeeEmail })
    .first();

  if (!employeeUser) {
    const password_hash = await bcrypt.hash(employeePlainPassword, 10);

    const insertedEmployee = await knex('users')
      .insert({
        org_id: orgId,
        employee_id: 'EMP-001',
        first_name: 'Demo',
        last_name: 'Employee',
        official_email: employeeEmail,
        password_hash,
        role: 'employee',
        status: 'ACTIVE',
        must_change_password: false,
        department_id: department.id,
        shift_id: shift.id,
      })
      .returning(['id']);

    employeeUser = insertedEmployee[0];
  }

  // 6a) Ensure a manager user for this demo org
  const managerEmail = 'manager.demo@shloka.local';
  const managerPlainPassword = 'Manager@123';

  let managerUser = await knex('users')
    .where({ org_id: orgId, official_email: managerEmail })
    .first();

  if (!managerUser) {
    const password_hash = await bcrypt.hash(managerPlainPassword, 10);

    const insertedManager = await knex('users')
      .insert({
        org_id: orgId,
        employee_id: 'MGR-001',
        first_name: 'Demo',
        last_name: 'Manager',
        official_email: managerEmail,
        password_hash,
        role: 'manager',
        status: 'ACTIVE',
        must_change_password: false,
        department_id: department.id,
        shift_id: shift.id,
      })
      .returning(['id']);

    managerUser = insertedManager[0];
  }

  // 7) Mark onboarding as COMPLETED so the employee can log in
  const nowIso = new Date().toISOString();
  const offerLetterUrl = 'https://example.com/demo-offer-letter.pdf';

  const existingOnboarding = await knex('user_onboardings')
    .where({ user_id: employeeUser.id })
    .first();

  if (!existingOnboarding) {
    await knex('user_onboardings').insert({
      user_id: employeeUser.id,
      asset_device_pref: 'WINDOWS',
      asset_agreement_accepted: true,
      policy_acknowledged: true,
      offer_letter_signed: true,
      offer_letter_url: offerLetterUrl,
      onboarding_status: 'COMPLETED',
      completed_at: nowIso,
    });
  } else {
    await knex('user_onboardings')
      .where({ user_id: employeeUser.id })
      .update({
        asset_device_pref: existingOnboarding.asset_device_pref ?? 'WINDOWS',
        asset_agreement_accepted: true,
        policy_acknowledged: true,
        offer_letter_signed: true,
        offer_letter_url: existingOnboarding.offer_letter_url ?? offerLetterUrl,
        onboarding_status: 'COMPLETED',
        completed_at: existingOnboarding.completed_at ?? nowIso,
      });
  }
}
