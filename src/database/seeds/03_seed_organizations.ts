import type { Knex } from 'knex';

import { logger } from '../../config/logger';
import { getDefaultOrganizationExpiresAt } from '../../utils/organization-expiry.utils';

export async function seed(knex: Knex): Promise<void> {
  const organizations = [
    {
      name: 'Acme Corporation',
      company_code: 'ACME001',
      contact_email: 'contact@acme.com',
      subscription_status: 'ACTIVE',
      logo_url: null,
    },
    {
      name: 'TechStart Inc',
      company_code: 'TECH001',
      contact_email: 'info@techstart.com',
      subscription_status: 'ACTIVE',
      logo_url: null,
    },
    {
      name: 'Global Solutions Ltd',
      company_code: 'GSL001',
      contact_email: 'hello@globalsolutions.com',
      subscription_status: 'ACTIVE',
      logo_url: null,
    },
    {
      name: 'Innovation Hub',
      company_code: 'INNOV001',
      contact_email: 'contact@innovationhub.com',
      subscription_status: 'ACTIVE',
      logo_url: null,
    },
    {
      name: 'Digital Ventures',
      company_code: 'DIGI001',
      contact_email: 'support@digitalventures.com',
      subscription_status: 'ACTIVE',
      logo_url: null,
    },
  ];

  // Check which organizations already exist
  const existingCodes = await knex('organizations')
    .select('company_code')
    .whereIn(
      'company_code',
      organizations.map((org) => org.company_code),
    );

  const existingCodeSet = new Set(existingCodes.map((row) => row.company_code));

  // Filter out organizations that already exist
  const newOrganizations = organizations.filter((org) => !existingCodeSet.has(org.company_code));

  if (newOrganizations.length === 0) {
    logger.info('All organizations already exist. Skipping seed.');
    return;
  }

  const defaultExpiresAt = getDefaultOrganizationExpiresAt().toISOString();
  const rowsWithExpiry = newOrganizations.map((org) => ({
    ...org,
    expires_at: defaultExpiresAt,
  }));

  // Insert new organizations
  await knex('organizations').insert(rowsWithExpiry);
  logger.info({ count: newOrganizations.length }, 'Successfully seeded organizations');
}
