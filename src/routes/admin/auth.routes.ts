import { Router } from 'express';

import { AdminAuthController } from '../../controllers/admin';

const adminAuthRoutes = Router();

adminAuthRoutes.post('/login', AdminAuthController.login);
adminAuthRoutes.post('/refresh', AdminAuthController.refresh);

export { adminAuthRoutes };
