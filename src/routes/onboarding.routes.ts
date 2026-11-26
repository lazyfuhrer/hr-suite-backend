import { Router } from 'express';
import multer from 'multer';

import { OnboardingController } from '../controllers/onboarding.controller';
import { authenticateTenant, authorizeRole } from '../middlewares';
import { env } from '../config/env';
import {
  bankMediaUploader,
  s3UploadMiddleware,
  s3UploadMiddlewareKeepOriginalName,
} from '../utils/s3Uploader';

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.S3_UPLOAD_MAX_MB * 1024 * 1024,
    files: 20,
  },
});

const bankAndAssetAdminPatchUploader = (req: any, res: any, next: any) => {
  if (req.is('multipart/form-data')) {
    upload.fields([{ name: 'cancelled_cheque', maxCount: 1 }])(req, res, next);
  } else {
    next();
  }
};

const onboardingRoutes = Router();

// All onboarding routes require a valid tenant token
onboardingRoutes.use(authenticateTenant);

// Admin / HR / Manager: start onboarding for a new employee.
// Creates User + Profile + EmergencyContacts + Addresses in a single transaction.
// Profile data is required in the request body.
onboardingRoutes.post(
  '/',
  authorizeRole(['admin', 'hr', 'manager']),
  OnboardingController.startOnboarding,
);
onboardingRoutes.get(
  '/in-progress-users',
  authorizeRole(['admin', 'hr', 'manager']),
  OnboardingController.listInProgressUsers,
);
const employeeDocumentFields = [
  { name: 'aadhar_front', maxCount: 1 },
  { name: 'aadhar_back', maxCount: 1 },
  { name: 'pan_card', maxCount: 1 },
  { name: 'passport_size_photo', maxCount: 1 },
  { name: 'passport', maxCount: 1 },
  { name: 'marksheet_10th', maxCount: 1 },
  { name: 'marksheet_12th', maxCount: 1 },
  { name: 'degree_certificate', maxCount: 1 },
  { name: 'previous_offer_letters', maxCount: 5 },
  { name: 'experience_letter', maxCount: 1 },
  { name: 'salary_slip_month_1', maxCount: 1 },
  { name: 'salary_slip_month_2', maxCount: 1 },
  { name: 'salary_slip_month_3', maxCount: 1 },
] as const;

// Self-service employee document upload (used during onboarding and later to add more docs)
onboardingRoutes.post(
  '/employee/documents',
  s3UploadMiddleware(employeeDocumentFields as any),
  OnboardingController.uploadDocumentEmployee,
);
// Alias for clarity in API: allows uploading additional documents that will appear in employee-overview
onboardingRoutes.post(
  '/employee/documents/upload-extra',
  s3UploadMiddlewareKeepOriginalName(employeeDocumentFields as any),
  OnboardingController.uploadDocumentEmployee,
);
// Employee / self-onboarding routes (act on the current authenticated user)
onboardingRoutes.get('/', OnboardingController.getState);
onboardingRoutes.put('/finance', OnboardingController.updateFinancials);
onboardingRoutes.put('/employment', OnboardingController.updateEmployment);
// Documents route: accepts files (multipart/form-data) OR metadata (JSON) for backward compatibility
onboardingRoutes.post('/documents', upload.any(), OnboardingController.uploadDocument);
onboardingRoutes.put('/compliance', OnboardingController.submitCompliance);

// Aadhaar KYC via Sandbox (mobile/self-service)
onboardingRoutes.post('/aadhaar/otp', OnboardingController.generateAadhaarOtp);
onboardingRoutes.post('/aadhaar/verify-otp', OnboardingController.verifyAadhaarOtp);

// PAN KYC via Sandbox (mobile/self-service)
onboardingRoutes.post('/pan/verify', OnboardingController.verifyPan);
onboardingRoutes.post('/bank/verify', OnboardingController.verifyBankAccount);

// Admin: audit log of Sandbox KYC API responses for the org (must be before /:userId)
onboardingRoutes.get(
  '/sandbox-kyc-logs',
  authorizeRole(['admin']),
  OnboardingController.listSandboxKycLogs,
);

// All company members (org admin, hr, manager, employee) can view onboarding state for a user in the same org.
onboardingRoutes.get(
  '/:userId',
  authorizeRole(['admin', 'hr', 'manager', 'employee']),
  OnboardingController.getState,
);
onboardingRoutes.get(
  '/:userId/profile',
  authorizeRole(['admin', 'hr', 'manager']),
  OnboardingController.getEmployeeProfileAdmin,
);
onboardingRoutes.put(
  '/:userId/profile',
  authorizeRole(['admin', 'hr', 'manager']),
  OnboardingController.updateOnboardingProfileAdmin,
);
onboardingRoutes.get(
  '/:userId/employee-overview',
  authorizeRole(['admin', 'hr', 'manager', 'employee']),
  OnboardingController.getEmployeeOverview,
);
onboardingRoutes.get(
  '/:userId/documents-summary',
  authorizeRole(['admin', 'hr', 'manager']),
  OnboardingController.getEmployeeDocumentsAdmin,
);
onboardingRoutes.get(
  '/:userId/manager-overview',
  authorizeRole(['manager', 'hr']),
  OnboardingController.getEmployeeManagerOverview,
);
onboardingRoutes.get(
  '/:userId/manager-overview/calendar',
  authorizeRole(['manager', 'hr']),
  OnboardingController.getEmployeeCalendar,
);
onboardingRoutes.get(
  '/:userId/manager-overview/hours-logged',
  authorizeRole(['manager', 'hr']),
  OnboardingController.getEmployeeHoursLogged,
);
onboardingRoutes.get(
  '/:userId/bank-and-asset',
  authorizeRole(['admin', 'hr', 'manager']),
  OnboardingController.getBankAndAssetAdmin,
);
onboardingRoutes.patch(
  '/:userId/bank-and-asset',
  authorizeRole(['admin', 'hr', 'manager']),
  bankAndAssetAdminPatchUploader,
  OnboardingController.patchBankAndAssetAdmin,
);
onboardingRoutes.put(
  '/:userId/finance',
  authorizeRole(['admin', 'hr', 'manager']),
  OnboardingController.updateFinancials,
);
onboardingRoutes.put(
  '/:userId/employment',
  authorizeRole(['admin', 'hr', 'manager']),
  OnboardingController.updateEmployment,
);
// Documents route: accepts files (multipart/form-data) OR metadata (JSON) for backward compatibility
onboardingRoutes.post(
  '/:userId/documents',
  authorizeRole(['admin', 'hr', 'manager']),
  upload.any(),
  OnboardingController.uploadDocument,
);
onboardingRoutes.put(
  '/:userId/documents/replace',
  authorizeRole(['admin', 'hr', 'manager']),
  upload.single('file'),
  OnboardingController.replaceUserDocument,
);
onboardingRoutes.post(
  '/:userId/documents/upload-new-doc',
  authorizeRole(['admin', 'hr', 'manager']),
  upload.single('file'),
  OnboardingController.uploadNewDocumentForUser,
);
onboardingRoutes.put(
  '/:userId/compliance',
  authorizeRole(['admin', 'hr', 'manager']),
  OnboardingController.submitCompliance,
);
onboardingRoutes.put('/profile', OnboardingController.updateProfile);

onboardingRoutes.post(
  '/bank-and-asset',
  bankMediaUploader,
  OnboardingController.upsertBankAndAsset,
);

onboardingRoutes.post(
  '/compliance',
  s3UploadMiddleware([{ name: 'signed_joining_letter', maxCount: 1 }]),
  OnboardingController.upsertCompliance,
);
onboardingRoutes.get('/org/docs', OnboardingController.getOrganizationDocuments);

export { onboardingRoutes };
