import type { Knex } from 'knex';

// Extend employee_benefits.benefit_type to allow BENEFIT_MENTAL_HEALTH_SUPPORT.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE employee_benefits
    DROP CONSTRAINT IF EXISTS employee_benefits_benefit_type_check;
  `);

  await knex.raw(`
    ALTER TABLE employee_benefits
    ADD CONSTRAINT employee_benefits_benefit_type_check
    CHECK (benefit_type IN (
      'ALLOWANCE_TRANSPORT',
      'ALLOWANCE_MEAL',
      'ALLOWANCE_INTERNET',
      'BENEFIT_HEALTH_INSURANCE',
      'BENEFIT_LIFE_INSURANCE',
      'BENEFIT_COMPANY_DEVICE',
      'BENEFIT_TRAINING',
      'BENEFIT_TUITION',
      'BENEFIT_FITNESS',
      'BENEFIT_MENTAL_HEALTH_SUPPORT'
    ));
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE employee_benefits
    DROP CONSTRAINT IF EXISTS employee_benefits_benefit_type_check;
  `);

  await knex.raw(`
    ALTER TABLE employee_benefits
    ADD CONSTRAINT employee_benefits_benefit_type_check
    CHECK (benefit_type IN (
      'ALLOWANCE_TRANSPORT',
      'ALLOWANCE_MEAL',
      'ALLOWANCE_INTERNET',
      'BENEFIT_HEALTH_INSURANCE',
      'BENEFIT_LIFE_INSURANCE',
      'BENEFIT_COMPANY_DEVICE',
      'BENEFIT_TRAINING',
      'BENEFIT_TUITION',
      'BENEFIT_FITNESS'
    ));
  `);
}
