import { Router } from 'express';

import { WorkShiftController } from '../../controllers/tenant/work-shift.controller';
import { authenticateTenant } from '../../middlewares';

const workShiftRoutes = Router();

workShiftRoutes.use(authenticateTenant);

workShiftRoutes.post('/', WorkShiftController.create);
workShiftRoutes.get('/', WorkShiftController.list);
workShiftRoutes.get('/:id', WorkShiftController.getById);
workShiftRoutes.put('/:id', WorkShiftController.update);
workShiftRoutes.delete('/:id', WorkShiftController.delete);

export { workShiftRoutes };
