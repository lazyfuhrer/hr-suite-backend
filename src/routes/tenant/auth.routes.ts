import { Router } from 'express';

import { AuthController } from '../../controllers/tenant';
import { authenticateTenant, authorizeRole } from '../../middlewares';

const authRoutes = Router();

authRoutes.post('/login', AuthController.login);
authRoutes.post('/select-org', AuthController.selectOrg);
authRoutes.get(
  '/switchable-orgs',
  authenticateTenant,
  authorizeRole(['admin', 'hr']),
  AuthController.listSwitchableOrgs,
);
authRoutes.post(
  '/switch-org',
  authenticateTenant,
  authorizeRole(['admin', 'hr']),
  AuthController.switchOrg,
);
authRoutes.post('/refresh', AuthController.refresh);
authRoutes.post('/reset-password', AuthController.resetPassword);
authRoutes.post('/forget-password', AuthController.forgetPassword);
authRoutes.post('/forget-password/resend', AuthController.resendForgetPasswordOtp);
authRoutes.post('/forget-password/verify-otp', AuthController.verifyForgetPasswordOtp);
authRoutes.post('/forget-password/reset', AuthController.resetForgetPassword);

export { authRoutes };
