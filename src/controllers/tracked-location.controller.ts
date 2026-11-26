import type { Request, Response } from 'express';

import { User } from '../models/User';
import {
  listTrackedLocations,
  persistTrackedLocations,
} from '../services/tracked-location.service';
import { getLocationTrackingStatus } from '../utils/location-tracking.utils';
import { invalidateTenantSessionsForUsers } from '../utils/session-invalidation.utils';
import {
  extractTrackedLocations,
  listTrackedLocationsQuerySchema,
  submitTrackedLocationsSchema,
  updateUserLocationTrackingSchema,
  userLocationTrackingParamsSchema,
} from '../validators';

export class TrackedLocationController {
  static async trackingStatus(req: Request, res: Response): Promise<Response> {
    if (!req.user || !req.orgId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const status = await getLocationTrackingStatus(req.orgId, req.user.id);
    if (!status) {
      return res.status(404).json({ message: 'User not found' });
    }

    return res.json({
      message: 'Location tracking status fetched successfully',
      data: status,
    });
  }

  static async getUserTrackingStatus(req: Request, res: Response): Promise<Response> {
    if (!req.user || !req.orgId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const params = userLocationTrackingParamsSchema.safeParse(req.params);
    if (!params.success) {
      return res.status(400).json({
        message: 'Invalid path parameters',
        errors: params.error.flatten().fieldErrors,
      });
    }

    const { userId } = params.data;
    const status = await getLocationTrackingStatus(req.orgId, userId);
    if (!status) {
      return res.status(404).json({ message: 'User not found' });
    }

    return res.json({
      message: 'Location tracking status fetched successfully',
      data: {
        user_id: userId,
        ...status,
      },
    });
  }

  static async updateUserTracking(req: Request, res: Response): Promise<Response> {
    if (!req.user || !req.orgId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const params = userLocationTrackingParamsSchema.safeParse(req.params);
    if (!params.success) {
      return res.status(400).json({
        message: 'Invalid path parameters',
        errors: params.error.flatten().fieldErrors,
      });
    }

    const parsed = updateUserLocationTrackingSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { userId } = params.data;
    const user = await User.query()
      .findOne({ id: userId, org_id: req.orgId })
      .whereNull('deleted_at');

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const previousOverride = user.location_tracking_enabled ?? null;
    const nextOverride = parsed.data.location_tracking_enabled;

    await user.$query().patch({
      location_tracking_enabled: nextOverride,
    });

    if (previousOverride !== nextOverride) {
      await invalidateTenantSessionsForUsers(req.orgId, [userId]);
    }

    const status = await getLocationTrackingStatus(req.orgId, userId);
    if (!status) {
      return res.status(404).json({ message: 'User not found' });
    }

    return res.json({
      message: 'Location tracking updated successfully',
      data: {
        user_id: userId,
        ...status,
      },
    });
  }

  static async submit(req: Request, res: Response): Promise<Response> {
    if (!req.user || !req.orgId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const trackingStatus = await getLocationTrackingStatus(req.orgId, req.user.id);
    if (!trackingStatus?.enabled) {
      return res.status(403).json({ message: 'Location tracking is disabled for this user' });
    }

    const parsed = submitTrackedLocationsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const locations = extractTrackedLocations(parsed.data);
    const result = await persistTrackedLocations(req.orgId, req.user.id, locations);

    // 200 (not 201): Transistorsoft deletes SQLite records on any 2xx; keep retries idempotent.
    return res.status(200).json({
      message: 'Locations accepted',
      data: {
        accepted: result.accepted,
        skipped: result.skipped,
      },
    });
  }

  static async list(req: Request, res: Response): Promise<Response> {
    if (!req.user || !req.orgId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = listTrackedLocationsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const result = await listTrackedLocations(req.orgId, parsed.data);

    return res.json({
      message: 'Tracked locations fetched successfully',
      data: result.data,
      pagination: result.pagination,
    });
  }
}
