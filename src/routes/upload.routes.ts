import { Router } from 'express';

import { UploadController } from '../controllers/upload.controller';
import { authenticateTenant } from '../middlewares';

const uploadRoutes = Router();

uploadRoutes.use(authenticateTenant);
uploadRoutes.post('/presign', UploadController.createPresignedUrl);
uploadRoutes.post('/', UploadController.uploadFile);

export { uploadRoutes };
