import { Router } from 'express';

import { GeofenceController } from '../../controllers/tenant/geofence.controller';
import { authenticateTenant, authorizeRole } from '../../middlewares';

const geofenceRoutes = Router();

geofenceRoutes.use(authenticateTenant);

geofenceRoutes.post('/', authorizeRole(['admin', 'hr', 'manager']), GeofenceController.create);
geofenceRoutes.get('/', GeofenceController.list);
geofenceRoutes.get(
  '/events',
  authorizeRole(['admin', 'hr', 'manager']),
  GeofenceController.listEvents,
);
geofenceRoutes.post('/:id/events', GeofenceController.recordEvent);
geofenceRoutes.get('/:id', GeofenceController.getById);
geofenceRoutes.put('/:id', authorizeRole(['admin', 'hr', 'manager']), GeofenceController.update);
geofenceRoutes.delete('/:id', authorizeRole(['admin', 'hr', 'manager']), GeofenceController.delete);

export { geofenceRoutes };
