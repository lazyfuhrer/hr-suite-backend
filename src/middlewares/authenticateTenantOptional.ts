import type { NextFunction, Request, Response } from 'express';

import { authenticateTenant } from './authenticateTenant';

/**
 * Best-effort tenant authentication.
 *
 * - If Authorization: Bearer ... is present, enforce tenant auth and populate req.user/req.orgId.
 * - If Authorization header is absent, continue without authenticating.
 *
 * This is useful for endpoints that support both internal-key and tenant-JWT auth modes.
 */
export const authenticateTenantOptional = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    await authenticateTenant(req, res, next);
    return;
  }
  next();
};
