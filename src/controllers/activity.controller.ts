import type { Request, Response } from 'express';

import { ActivityLogService } from '../services/activity-log.service';
import { activityListQuerySchema } from '../validators';

export class ActivityController {
  static async listOrgActivities(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = activityListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid query parameters',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const payload = await ActivityLogService.listOrgActivities({
      org_id: req.user.org_id,
      page: parsed.data.page,
      limit: parsed.data.limit,
      activity_type: parsed.data.activity_type,
      actor_user_id: parsed.data.actor_user_id,
      target_user_id: parsed.data.target_user_id,
      from_date: parsed.data.from_date,
      to_date: parsed.data.to_date,
    });

    return res.json(payload);
  }
}
