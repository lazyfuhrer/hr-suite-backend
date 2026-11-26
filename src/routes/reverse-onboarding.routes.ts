import { Router } from 'express';

import { ReverseOnboardingController } from '../controllers/reverse-onboarding.controller';
import { authenticateTenant, authorizeRole } from '../middlewares';

const reverseOnboardingRoutes = Router();

// All reverse-onboarding routes require an authenticated tenant.
reverseOnboardingRoutes.use(authenticateTenant);

// Admin / HR / Manager: list draft reverse-onboarding users (INVITED/REJECTED).
reverseOnboardingRoutes.get(
  '/users',
  authorizeRole(['admin', 'hr', 'manager']),
  ReverseOnboardingController.listDraftUsers,
);

// Admin / HR / Manager: create an invited user who will self-complete onboarding.
reverseOnboardingRoutes.post(
  '/users',
  authorizeRole(['admin', 'hr', 'manager']),
  ReverseOnboardingController.inviteUser,
);

// Admin / HR / Manager: trigger KYC verification for a specific user.
reverseOnboardingRoutes.post(
  '/users/:userId/verify',
  authorizeRole(['admin', 'hr', 'manager']),
  ReverseOnboardingController.verifyUserKyc,
);

export { reverseOnboardingRoutes };
