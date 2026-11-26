import { Organization } from '../models/Organization';

export const DEFAULT_OT_ROUND_OFF_MINS = 15;

export type OrgOtRoundOffSettings = {
  enabled: boolean;
  mins: number;
};

export async function getOrgOtRoundOffSettings(orgId: string): Promise<OrgOtRoundOffSettings> {
  const org = await Organization.query()
    .findById(orgId)
    .select('ot_round_off_enabled', 'ot_round_off_mins')
    .first();

  const enabled =
    (org as { ot_round_off_enabled?: boolean } | undefined)?.ot_round_off_enabled === true;
  const minsRaw = (org as { ot_round_off_mins?: number } | undefined)?.ot_round_off_mins;
  const mins =
    Number.isInteger(minsRaw) && (minsRaw as number) >= 1
      ? (minsRaw as number)
      : DEFAULT_OT_ROUND_OFF_MINS;

  return { enabled, mins };
}
