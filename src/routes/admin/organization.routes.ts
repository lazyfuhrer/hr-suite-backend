import { Router } from 'express';

import { OrganizationController } from '../../controllers/admin';
import { authenticateSuperAdmin } from '../../middlewares';

const organizationRoutes = Router();

// Routes for Super Admin
organizationRoutes.post('/', authenticateSuperAdmin, OrganizationController.create);
organizationRoutes.post(
  '/:orgId/admin',
  authenticateSuperAdmin,
  OrganizationController.createAdmin,
);
organizationRoutes.get('/', authenticateSuperAdmin, OrganizationController.list);
organizationRoutes.patch(
  '/:id/status',
  authenticateSuperAdmin,
  OrganizationController.updateStatus,
);

organizationRoutes.patch(
  '/:id/expiry',
  authenticateSuperAdmin,
  OrganizationController.updateExpiry,
);

organizationRoutes.patch(
  '/:id/user-limit',
  authenticateSuperAdmin,
  OrganizationController.updateUserLimit,
);

organizationRoutes.patch(
  '/:id/settings',
  authenticateSuperAdmin,
  OrganizationController.updatePrivilegedSettings,
);

export { organizationRoutes };
