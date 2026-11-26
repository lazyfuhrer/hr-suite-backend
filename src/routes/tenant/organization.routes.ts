import { Router } from 'express';
import multer from 'multer';

import { OrganizationController } from '../../controllers/admin';
import { authenticateTenant, authorizeRole } from '../../middlewares';

const tenantOrganizationRoutes = Router();
const upload = multer({ storage: multer.memoryStorage() });

tenantOrganizationRoutes.use(authenticateTenant);
tenantOrganizationRoutes.use(authorizeRole(['admin', 'hr', 'manager']));

tenantOrganizationRoutes.get('/', OrganizationController.getSettings);
tenantOrganizationRoutes.put(
  '/',
  upload.fields([
    { name: 'logo', maxCount: 1 },
    { name: 'favicon', maxCount: 1 },
  ]),
  OrganizationController.updateSettings,
);

export { tenantOrganizationRoutes };
