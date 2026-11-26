import { Organization } from '../models/Organization';

export const DEFAULT_LATE_GRACE_PERIOD_MINS = 15;

export async function getOrgLateGracePeriodMins(orgId: string): Promise<number> {
  const org = await Organization.query().findById(orgId).select('late_grace_period_mins').first();

  const value = (org as any)?.late_grace_period_mins;
  return Number.isInteger(value) ? value : DEFAULT_LATE_GRACE_PERIOD_MINS;
}
