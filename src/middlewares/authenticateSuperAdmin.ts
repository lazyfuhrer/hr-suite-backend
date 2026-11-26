import type { NextFunction, Request, Response } from 'express';

import { SuperAdmin } from '../models/SuperAdmin';
import { verifyToken } from '../services/jwt.service';

export const authenticateSuperAdmin = async (
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

  if (payload.type === 'tenant') {
    res.status(403).json({ message: 'Forbidden' });
    return;
  }

  if (payload.type !== 'platform' || payload.role !== 'super_admin') {
    res.status(401).json({ message: 'Unauthorized' });
    return;
  }

  const admin = await SuperAdmin.query().findById(payload.id);
  if (!admin) {
    res.status(401).json({ message: 'Unauthorized' });
    return;
  }

  req.admin = admin;
  next();
};
