import type { Request, Response } from 'express';

import {
  createLocationSnapshot,
  listLocationSnapshots,
} from '../services/location-snapshot.service';
import { listLocationSnapshotsQuerySchema, submitLocationSnapshotSchema } from '../validators';

export class LocationSnapshotController {
  static async submit(req: Request, res: Response): Promise<Response> {
    if (!req.user || !req.orgId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = submitLocationSnapshotSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const snapshot = await createLocationSnapshot(req.orgId, req.user.id, {
      latitude: parsed.data.latitude,
      longitude: parsed.data.longitude,
      captured_at: parsed.data.captured_at,
      prompt_slot_key: parsed.data.prompt_slot_key,
    });

    return res.status(201).json({
      message: 'Location snapshot saved successfully',
      data: snapshot,
    });
  }

  static async list(req: Request, res: Response): Promise<Response> {
    if (!req.user || !req.orgId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = listLocationSnapshotsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const result = await listLocationSnapshots(req.orgId, parsed.data);

    return res.json({
      message: 'Location snapshots fetched successfully',
      data: result.data,
      pagination: result.pagination,
    });
  }
}
