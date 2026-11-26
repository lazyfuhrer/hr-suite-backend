import { Router } from 'express';

import { LocationSnapshotController } from '../controllers/location-snapshot.controller';
import { NotificationsController } from '../controllers/notifications.controller';
import { authenticateTenant, authenticateTenantOptional, authorizeRole } from '../middlewares';

const notificationsRoutes = Router();

// Client-facing device registration (requires tenant JWT)
notificationsRoutes.post(
  '/devices/register',
  authenticateTenant,
  NotificationsController.registerDeviceToken,
);

notificationsRoutes.get(
  '/logs',
  authenticateTenant,
  authorizeRole(['admin', 'hr', 'manager']),
  NotificationsController.listLogs,
);

notificationsRoutes.get(
  '/logs/:id',
  authenticateTenant,
  authorizeRole(['admin', 'hr', 'manager']),
  NotificationsController.getLog,
);

notificationsRoutes.get(
  '/settings',
  authenticateTenant,
  authorizeRole(['admin', 'hr', 'manager']),
  NotificationsController.getSettings,
);

notificationsRoutes.put(
  '/settings',
  authenticateTenant,
  authorizeRole(['admin', 'hr', 'manager']),
  NotificationsController.updateSettings,
);

notificationsRoutes.patch(
  '/settings',
  authenticateTenant,
  authorizeRole(['admin', 'hr', 'manager']),
  NotificationsController.updateSettings,
);

notificationsRoutes.post(
  '/location-snapshots',
  authenticateTenant,
  LocationSnapshotController.submit,
);

notificationsRoutes.get(
  '/location-snapshots',
  authenticateTenant,
  authorizeRole(['admin', 'hr', 'manager']),
  LocationSnapshotController.list,
);

// Generic event trigger (internal callers)
notificationsRoutes.post('/trigger', authenticateTenantOptional, NotificationsController.trigger);

export { notificationsRoutes };
