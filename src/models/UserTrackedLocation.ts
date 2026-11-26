import { BaseModel } from './BaseModel';

export class UserTrackedLocation extends BaseModel {
  static tableName = 'user_tracked_locations';

  org_id!: string;
  user_id!: string;
  sdk_uuid!: string;
  latitude!: string;
  longitude!: string;
  accuracy!: string | null;
  speed!: string | null;
  heading!: string | null;
  altitude!: string | null;
  activity_type!: string | null;
  activity_confidence!: number | null;
  battery_level!: string | null;
  battery_is_charging!: boolean | null;
  event!: string | null;
  is_moving!: boolean | null;
  odometer!: string | null;
  age!: number | null;
  extras!: Record<string, unknown> | null;
  geofence_identifier!: string | null;
  geofence_action!: string | null;
  recorded_at!: Date;
}
