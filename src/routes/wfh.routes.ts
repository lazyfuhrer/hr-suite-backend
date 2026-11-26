import { Router } from 'express';

import { WfhController } from '../controllers/wfh.controller';
import { authenticateTenant, authorizeRole } from '../middlewares';
import { wfhAttachmentUploader } from '../utils/s3Uploader';

const wfhRoutes = Router();

wfhRoutes.use(authenticateTenant);

wfhRoutes.get('/my', WfhController.listMyRequests);
wfhRoutes.post('/requests', wfhAttachmentUploader, WfhController.applyWfh);
wfhRoutes.get(
  '/requests',
  authorizeRole(['admin', 'hr', 'manager']),
  WfhController.listOrgRequests,
);
wfhRoutes.post(
  '/requests/approve',
  authorizeRole(['admin', 'hr', 'manager']),
  WfhController.approveRequest,
);
wfhRoutes.get('/requests/:id', WfhController.getWfhRequestById);
wfhRoutes.put('/requests/:id', wfhAttachmentUploader, WfhController.updateWfhRequest);
wfhRoutes.post('/requests/:id/cancel', WfhController.cancelWfhRequest);
wfhRoutes.patch('/requests/:id/status', WfhController.updateStatus);

export { wfhRoutes };
