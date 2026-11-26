import { Router } from 'express';

import { ReimbursementController } from '../controllers/reimbursement.controller';
import { authenticateTenant, authorizeRole } from '../middlewares';
import { reimbursementAttachmentUploader } from '../utils/s3Uploader';

const reimbursementRoutes = Router();

reimbursementRoutes.use(authenticateTenant);

reimbursementRoutes.get('/my', ReimbursementController.listMyRequests);
reimbursementRoutes.post(
  '/requests',
  reimbursementAttachmentUploader,
  ReimbursementController.applyReimbursement,
);
reimbursementRoutes.get(
  '/requests',
  authorizeRole(['admin', 'hr', 'manager']),
  ReimbursementController.listOrgRequests,
);
reimbursementRoutes.get('/requests/:id', ReimbursementController.getReimbursementRequestById);
reimbursementRoutes.put(
  '/requests/:id',
  reimbursementAttachmentUploader,
  ReimbursementController.updateReimbursementRequest,
);
reimbursementRoutes.post(
  '/requests/:id/cancel',
  ReimbursementController.cancelReimbursementRequest,
);

reimbursementRoutes.post(
  '/requests/approve',
  authorizeRole(['admin', 'hr', 'manager']),
  ReimbursementController.approveRequest,
);

reimbursementRoutes.patch('/requests/:id/status', ReimbursementController.updateStatus);

export { reimbursementRoutes };
