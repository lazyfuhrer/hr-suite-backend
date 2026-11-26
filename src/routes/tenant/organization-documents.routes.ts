import { Router } from 'express';

import { authenticateTenant, authorizeRole } from '../../middlewares';
import { OrganizationDocumentController } from '../../controllers/tenant/organizationDocument.controller';
import { s3OrgUploadMiddleware } from '../../utils/s3Uploader';

const organizationDocumentRoutes = Router();

organizationDocumentRoutes.use(authenticateTenant);
organizationDocumentRoutes.use(authorizeRole(['admin', 'hr']));

organizationDocumentRoutes.post(
  '/',
  s3OrgUploadMiddleware(),
  OrganizationDocumentController.create,
);
organizationDocumentRoutes.get('/', OrganizationDocumentController.getAll);
organizationDocumentRoutes.put(
  '/:id',
  s3OrgUploadMiddleware(),
  OrganizationDocumentController.update,
);
organizationDocumentRoutes.delete('/:id', OrganizationDocumentController.remove);

export { organizationDocumentRoutes };
