import { Router } from 'express';

import { DashboardController } from '../../controllers/tenant/dashboard.controller';
import { authenticateTenant, authorizeRole } from '../../middlewares';

const dashboardRoutes = Router();

dashboardRoutes.use(authenticateTenant);
dashboardRoutes.use(authorizeRole(['admin', 'hr', 'manager']));

dashboardRoutes.get(
  '/manager/team-stats',
  authorizeRole(['manager', 'hr']),
  DashboardController.getManagerTeamStats,
);
dashboardRoutes.get('/', DashboardController.getAdminDashboard);

export { dashboardRoutes };
