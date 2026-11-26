import type { Request, Response } from 'express';

import { WorkShift } from '../../models/WorkShift';
import { createWorkShiftSchema, updateWorkShiftSchema } from '../../validators';

export class WorkShiftController {
  static async create(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = createWorkShiftSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { name, start_time, end_time, break_start_time, break_end_time, break_duration_mins } =
      parsed.data;
    const org_id = req.user.org_id;

    const existing = await WorkShift.query().findOne({ org_id, name });
    if (existing) {
      return res.status(409).json({ message: 'Work shift with this name already exists' });
    }

    const created = await WorkShift.query().insert({
      org_id,
      name,
      start_time,
      end_time,
      break_start_time,
      break_end_time,
      break_duration_mins: break_duration_mins ?? 60,
    });

    return res.status(201).json(created);
  }

  static async list(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const shifts = await WorkShift.query().where('org_id', req.user.org_id).orderBy('name', 'asc');

    return res.json(shifts);
  }

  static async getById(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    const shift = await WorkShift.query().where('id', id).where('org_id', req.user.org_id).first();

    if (!shift) {
      return res.status(404).json({ message: 'Work shift not found' });
    }

    return res.json(shift);
  }

  static async update(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    const parsed = updateWorkShiftSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const shift = await WorkShift.query().where('id', id).where('org_id', req.user.org_id).first();

    if (!shift) {
      return res.status(404).json({ message: 'Work shift not found' });
    }

    const updateData: any = {};
    if (parsed.data.name !== shift.name) {
      const existing = await WorkShift.query()
        .where('org_id', req.user.org_id)
        .where('name', parsed.data.name)
        .whereNot('id', id)
        .first();
      if (existing) {
        return res.status(409).json({ message: 'Work shift with this name already exists' });
      }
    }
    updateData.name = parsed.data.name;
    updateData.start_time = parsed.data.start_time;
    updateData.end_time = parsed.data.end_time;
    updateData.break_start_time = parsed.data.break_start_time;
    updateData.break_end_time = parsed.data.break_end_time;
    updateData.break_duration_mins = parsed.data.break_duration_mins;

    const updated = await WorkShift.query().patchAndFetchById(id, updateData);

    return res.json(updated);
  }

  static async delete(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { id } = req.params;
    const shift = await WorkShift.query().where('id', id).where('org_id', req.user.org_id).first();

    if (!shift) {
      return res.status(404).json({ message: 'Work shift not found' });
    }

    await WorkShift.query().deleteById(id);

    return res.json({ message: 'Work shift deleted successfully' });
  }
}
