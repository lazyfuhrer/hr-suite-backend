import type { Request, Response } from 'express';

import { logger } from '../../config/logger';
import { Geofence } from '../../models/Geofence';
import { GeofenceEvent } from '../../models/GeofenceEvent';
import { User } from '../../models/User';
import { listGeofenceEvents } from '../../services/geofence-event.service';
import { notifyGeofenceEvent } from '../../services/notifications/geofence-notification.service';
import {
  createGeofenceEventSchema,
  createGeofenceSchema,
  listGeofenceEventsQuerySchema,
  updateGeofenceSchema,
} from '../../validators';

export class GeofenceController {
  static async create(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = createGeofenceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten((issue) => issue.message).fieldErrors,
      });
    }

    const { org_id, user_id, landmark, latitude, longitude, radius_meters } = parsed.data;

    if (org_id !== req.user.org_id) {
      return res.status(403).json({ message: 'Organization mismatch' });
    }

    const targetUser = await User.query()
      .where({ id: user_id, org_id })
      .whereNull('deleted_at')
      .first();

    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    const created = await Geofence.query().insert({
      org_id,
      user_id: targetUser.id,
      landmark,
      latitude: String(latitude),
      longitude: String(longitude),
      radius_meters: radius_meters ?? 100,
    });

    return res.status(201).json(created);
  }

  static async list(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const geofences = await Geofence.query()
      .where('org_id', req.user.org_id)
      .orderBy('landmark', 'asc');

    return res.json(geofences);
  }

  static async listEvents(req: Request, res: Response): Promise<Response> {
    if (!req.user || !req.orgId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = listGeofenceEventsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const result = await listGeofenceEvents(req.orgId, parsed.data);

    return res.json({
      message: 'Geofence events fetched successfully',
      data: result.data,
      pagination: result.pagination,
    });
  }

  static async getById(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    const geofence = await Geofence.query()
      .where('id', id)
      .where('org_id', req.user.org_id)
      .first();

    if (!geofence) {
      return res.status(404).json({ message: 'Geofence not found' });
    }

    return res.json(geofence);
  }

  static async update(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    const parsed = updateGeofenceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten((issue) => issue.message).fieldErrors,
      });
    }

    const { org_id, user_id, landmark, latitude, longitude, radius_meters } = parsed.data;

    if (org_id !== req.user.org_id) {
      return res.status(403).json({ message: 'Organization mismatch' });
    }

    const targetUser = await User.query()
      .where({ id: user_id, org_id })
      .whereNull('deleted_at')
      .first();

    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    const geofence = await Geofence.query().where('id', id).where('org_id', org_id).first();

    if (!geofence) {
      return res.status(404).json({ message: 'Geofence not found' });
    }

    const updated = await Geofence.query().patchAndFetchById(id, {
      org_id,
      user_id: targetUser.id,
      landmark,
      latitude: String(latitude),
      longitude: String(longitude),
      radius_meters: radius_meters ?? 100,
    });

    return res.json(updated);
  }

  static async delete(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    const geofence = await Geofence.query()
      .where('id', id)
      .where('org_id', req.user.org_id)
      .first();

    if (!geofence) {
      return res.status(404).json({ message: 'Geofence not found' });
    }

    await Geofence.query().deleteById(id);

    return res.json({ message: 'Geofence deleted successfully' });
  }

  static async recordEvent(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    const parsed = createGeofenceEventSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten((issue) => issue.message).fieldErrors,
      });
    }

    const geofence = await Geofence.query()
      .where('id', id)
      .where('org_id', req.user.org_id)
      .first();

    if (!geofence) {
      return res.status(404).json({ message: 'Geofence not found' });
    }

    const { event_type, latitude, longitude, device_token, platform } = parsed.data;
    const created = await GeofenceEvent.query().insert({
      org_id: req.user.org_id,
      geofence_id: geofence.id,
      user_id: req.user.id,
      event_type,
      latitude: latitude !== undefined ? String(latitude) : null,
      longitude: longitude !== undefined ? String(longitude) : null,
      recorded_at: new Date(),
    });

    try {
      await notifyGeofenceEvent({
        orgId: req.user.org_id,
        userId: req.user.id,
        geofenceId: geofence.id,
        geofenceEventId: created.id,
        eventType: event_type,
        landmark: geofence.landmark,
        deviceToken: device_token,
        platform,
      });
    } catch (err) {
      logger.error(
        {
          err,
          org_id: req.user.org_id,
          geofenceId: geofence.id,
          geofenceEventId: created.id,
          userId: req.user.id,
        },
        'Failed to send geofence event notification',
      );
    }

    return res.status(201).json(created);
  }
}
