import { Router } from 'express';

import { LeaveController } from '../controllers/leave.controller';
import { authenticateTenant, authorizeRole } from '../middlewares';
import { leaveAttachmentUploader } from '../utils/s3Uploader';

const leaveRoutes = Router();

leaveRoutes.use(authenticateTenant);

leaveRoutes.get('/types', LeaveController.listLeaveTypes);
leaveRoutes.post('/types', authorizeRole(['admin', 'hr']), LeaveController.createLeaveType);
leaveRoutes.put('/types/:id', authorizeRole(['admin', 'hr']), LeaveController.updateLeaveType);
leaveRoutes.delete('/types/:id', authorizeRole(['admin', 'hr']), LeaveController.deleteLeaveType);
leaveRoutes.get('/my/summary', LeaveController.getMySummary);
leaveRoutes.get('/my', LeaveController.listMyRequests);
leaveRoutes.post('/requests', leaveAttachmentUploader, LeaveController.applyLeave);
leaveRoutes.get(
  '/requests',
  authorizeRole(['admin', 'hr', 'manager']),
  LeaveController.listOrgRequests,
);
leaveRoutes.get('/requests/:id', LeaveController.getLeaveRequestById);
leaveRoutes.put('/requests/:id', LeaveController.updateLeaveRequest);
leaveRoutes.post('/requests/:id/cancel', LeaveController.cancelLeaveRequest);

leaveRoutes.post(
  '/requests/approve',
  authorizeRole(['admin', 'hr', 'manager']),
  LeaveController.approveRequest,
);

leaveRoutes.patch('/requests/:id/status', LeaveController.updateStatus);

leaveRoutes.get(
  '/dashboard/manager-employees',
  authorizeRole(['manager', 'hr']),
  LeaveController.getManagerEmployeesDashboard,
);

leaveRoutes.get(
  '/dashboard',
  authorizeRole(['admin', 'hr', 'manager']),
  LeaveController.getDashboard,
);

export { leaveRoutes };
