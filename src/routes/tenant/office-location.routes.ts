import { Router } from 'express';

import { OfficeLocationController } from '../../controllers/tenant/office-location.controller';
import { authenticateTenant } from '../../middlewares';

const officeLocationRoutes = Router();

officeLocationRoutes.use(authenticateTenant);

officeLocationRoutes.post('/', OfficeLocationController.create);
officeLocationRoutes.get('/', OfficeLocationController.list);
officeLocationRoutes.get('/:id', OfficeLocationController.getById);
officeLocationRoutes.put('/:id', OfficeLocationController.update);
officeLocationRoutes.delete('/:id', OfficeLocationController.delete);

export { officeLocationRoutes };
