import { Router } from 'express';

import { DepartmentController } from '../../controllers/tenant';
import { authenticateTenant, authorizeRole } from '../../middlewares';

const departmentRoutes = Router();

departmentRoutes.use(authenticateTenant);

departmentRoutes.get(
  '/statistics',
  authorizeRole(['admin', 'hr', 'manager']),
  DepartmentController.getStatistics,
);

// List departments: accessible to all company members (org admin, hr, manager, employee)
departmentRoutes.get(
  '/',
  authorizeRole(['admin', 'hr', 'manager', 'employee']),
  DepartmentController.list,
);

departmentRoutes.use(authorizeRole(['admin', 'hr']));

departmentRoutes.post('/', DepartmentController.create);
departmentRoutes.get('/dashboard', DepartmentController.dashboard);
departmentRoutes.get('/:id', DepartmentController.getById);
departmentRoutes.put('/:id/manager', DepartmentController.updateManager);
departmentRoutes.post('/:id/employees', DepartmentController.assignEmployees);
departmentRoutes.get('/:id/summary', DepartmentController.getEmployeeSummary);
departmentRoutes.get('/:id/users', DepartmentController.getEmployeeList);
departmentRoutes.put('/:id', DepartmentController.update);
departmentRoutes.delete('/:id', DepartmentController.delete);

export { departmentRoutes };
