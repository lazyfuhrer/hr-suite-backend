import { Router } from 'express';

import { HolidayController } from '../../controllers/tenant/holiday.controller';
import { authenticateTenant, authorizeRole } from '../../middlewares';

const holidayRoutes = Router();

holidayRoutes.use(authenticateTenant);
holidayRoutes.use(authorizeRole(['admin']));

holidayRoutes.get('/', HolidayController.list);
holidayRoutes.post('/', HolidayController.create);
holidayRoutes.delete('/:id', HolidayController.delete);

export { holidayRoutes };
