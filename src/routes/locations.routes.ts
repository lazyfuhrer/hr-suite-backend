import { Router } from 'express';

import { TrackedLocationController } from '../controllers/tracked-location.controller';
import { authenticateTenant, authorizeRole } from '../middlewares';

const locationsRoutes = Router();

locationsRoutes.get(
  '/tracking-status',
  authenticateTenant,
  TrackedLocationController.trackingStatus,
);

locationsRoutes.post('/', authenticateTenant, TrackedLocationController.submit);

locationsRoutes.get(
  '/',
  authenticateTenant,
  authorizeRole(['admin', 'hr', 'manager']),
  TrackedLocationController.list,
);

export { locationsRoutes };
