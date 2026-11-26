import type { Request, Response } from 'express';

import { OfficeLocation } from '../../models/OfficeLocation';
import { createOfficeLocationSchema, updateOfficeLocationSchema } from '../../validators';

export class OfficeLocationController {
  static async create(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = createOfficeLocationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten((issue) => issue.message).fieldErrors,
      });
    }

    const { name, latitude, longitude, radius_meters, address } = parsed.data;
    const org_id = req.user.org_id;

    const existing = await OfficeLocation.query().findOne({ org_id, name });
    if (existing) {
      return res.status(409).json({ message: 'Office location with this name already exists' });
    }

    const created = await OfficeLocation.query().insert({
      org_id,
      name,
      latitude: String(latitude),
      longitude: String(longitude),
      radius_meters: radius_meters ?? 100,
      address,
    });

    return res.status(201).json(created);
  }

  static async list(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const locations = await OfficeLocation.query()
      .where('org_id', req.user.org_id)
      .orderBy('name', 'asc');

    return res.json(locations);
  }

  static async getById(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    const location = await OfficeLocation.query()
      .where('id', id)
      .where('org_id', req.user.org_id)
      .first();

    if (!location) {
      return res.status(404).json({ message: 'Office location not found' });
    }

    return res.json(location);
  }

  static async update(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    const parsed = updateOfficeLocationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten((issue) => issue.message).fieldErrors,
      });
    }

    const location = await OfficeLocation.query()
      .where('id', id)
      .where('org_id', req.user.org_id)
      .first();

    if (!location) {
      return res.status(404).json({ message: 'Office location not found' });
    }

    const updateData: any = {};
    if (parsed.data.name !== undefined) {
      if (parsed.data.name !== location.name) {
        const existing = await OfficeLocation.query()
          .where('org_id', req.user.org_id)
          .where('name', parsed.data.name)
          .whereNot('id', id)
          .first();
        if (existing) {
          return res.status(409).json({ message: 'Office location with this name already exists' });
        }
      }
      updateData.name = parsed.data.name;
    }
    if (parsed.data.latitude !== undefined) {
      updateData.latitude = String(parsed.data.latitude);
    }
    if (parsed.data.longitude !== undefined) {
      updateData.longitude = String(parsed.data.longitude);
    }
    if (parsed.data.radius_meters !== undefined) {
      updateData.radius_meters = parsed.data.radius_meters;
    }
    if (parsed.data.address !== undefined) {
      updateData.address = parsed.data.address;
    }

    const updated = await OfficeLocation.query().patchAndFetchById(id, updateData);

    return res.json(updated);
  }

  static async delete(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    const location = await OfficeLocation.query()
      .where('id', id)
      .where('org_id', req.user.org_id)
      .first();

    if (!location) {
      return res.status(404).json({ message: 'Office location not found' });
    }

    await OfficeLocation.query().deleteById(id);

    return res.json({ message: 'Office location deleted successfully' });
  }
}
