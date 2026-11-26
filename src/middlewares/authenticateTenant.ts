import type { NextFunction, Request, Response } from 'express';

import { User } from '../models/User';
import { verifyToken } from '../services/jwt.service';
import {
  OrganizationAccessSnapshot,
  sendOrganizationAccessDenied,
} from '../utils/organization-expiry.utils';

export const authenticateTenant = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ message: 'Unauthorized' });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    res.status(401).json({ message: 'Unauthorized' });
    return;
  }

  if (payload.type !== 'tenant') {
    res.status(403).json({ message: 'Forbidden' });
    return;
  }

  if (!payload.id || !payload.org_id) {
    res.status(401).json({ message: 'Unauthorized' });
    return;
  }

  const user = await User.query()
    .withGraphJoined('organization')
    .whereRaw('users.id = ? and users.org_id = ?', [payload.id, payload.org_id])
    .first();
  if (!user || user.status === 'INACTIVE') {
    res.status(401).json({ message: 'Unauthorized' });
    return;
  }

  if (user.sessions_invalidated_at) {
    const invalidatedAtSec = Math.floor(new Date(user.sessions_invalidated_at).getTime() / 1000);
    if (typeof payload.iat !== 'number' || payload.iat < invalidatedAtSec) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
  }

  const orgStatus = (user as User & { organization?: OrganizationAccessSnapshot }).organization;
  if (sendOrganizationAccessDenied(res, orgStatus)) {
    return;
  }

  if (user.must_change_password) {
    res.status(403).json({ message: 'Password reset required' });
    return;
  }

  req.user = user;
  req.orgId = payload.org_id;
  next();
};
