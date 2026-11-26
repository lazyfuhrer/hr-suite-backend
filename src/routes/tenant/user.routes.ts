import { Router } from 'express';
import multer from 'multer';

import { EmployeeExitController, UserController } from '../../controllers/tenant';
import { HolidayController } from '../../controllers/tenant/holiday.controller';
import { TrackedLocationController } from '../../controllers/tracked-location.controller';
import { BULK_IMPORT_MAX_BYTES } from '../../validators/tenant/user-bulk-import.validator';
import { env } from '../../config/env';
import { authenticateTenant, authorizeRole } from '../../middlewares';

const userRoutes = Router();

const reindexFaceUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.S3_UPLOAD_MAX_MB * 1024 * 1024,
    files: 1,
  },
});

const profileImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.S3_UPLOAD_MAX_MB * 1024 * 1024,
    files: 1,
  },
});

const bulkImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: BULK_IMPORT_MAX_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    if (
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.mimetype === 'application/vnd.ms-excel'
    ) {
      cb(null, true);
      return;
    }
    cb(new Error('Invalid file type. Only Excel files (.xlsx, .xls) are allowed.'));
  },
});

userRoutes.use(authenticateTenant);

// Employee self-service route (accessible to all authenticated users)
userRoutes.put(
  '/me/personal-info',
  profileImageUpload.single('profile_image'),
  UserController.updateMyPersonalInfo,
);

// Device accounts (admin only)
userRoutes.post('/devices', authorizeRole(['admin']), UserController.createDevice);
userRoutes.get('/devices', authorizeRole(['admin']), UserController.listDevices);
// Re-index user face: optional multipart `image` replaces PASSPORT_SIZE_PHOTO then reindexes; else use stored passport photo (admin only)
userRoutes.post(
  '/:userId/reindex-face',
  authorizeRole(['admin']),
  reindexFaceUpload.single('image'),
  UserController.reindexFace,
);

// Admin/HR/Manager list route
userRoutes.get('/', authorizeRole(['admin', 'hr', 'manager']), UserController.list);
userRoutes.get(
  '/download-excel',
  authorizeRole(['admin', 'hr', 'manager']),
  UserController.downloadUsersExcel,
);
userRoutes.get(
  '/upcoming-birthdays',
  authorizeRole(['admin', 'hr', 'manager', 'employee']),
  UserController.getUpcomingBirthdays,
);

// All company members (org admin, hr, manager, employee) can view leave summary for a user in the same org.
userRoutes.get(
  '/:userId/leaves',
  authorizeRole(['admin', 'hr', 'manager', 'employee']),
  UserController.getEmployeeLeaves,
);

// Location tracking status for a specific user (admin/hr/manager)
userRoutes.get(
  '/:userId/location-tracking',
  authorizeRole(['admin', 'hr', 'manager']),
  TrackedLocationController.getUserTrackingStatus,
);

// Per-user org holiday enable/disable (admin/hr org-wide; manager = managed-dept employees)
userRoutes.get(
  '/:userId/holidays',
  authorizeRole(['admin', 'hr', 'manager']),
  HolidayController.listForUser,
);
userRoutes.put(
  '/:userId/holidays',
  authorizeRole(['admin', 'hr', 'manager']),
  HolidayController.upsertForUser,
);

// Admin/HR only routes
userRoutes.use(authorizeRole(['admin', 'hr']));

// Legacy employee creation endpoint.
// Prefer using POST /api/onboarding/employees for creating new employees.
userRoutes.post('/', UserController.create);
userRoutes.post('/cross-org-sync', UserController.crossOrgSync);
userRoutes.get('/unassigned', UserController.listUnassigned);
userRoutes.post('/send-temporary-password', UserController.sendTemporaryPassword);
userRoutes.get('/bulk-import/template', UserController.downloadBulkImportTemplate);
userRoutes.post('/bulk-import', bulkImportUpload.single('file'), UserController.bulkImportUsers);

// Employee exit (must be registered before /:userId catch-all)
userRoutes.get('/:userId/exit/preview', EmployeeExitController.preview);
userRoutes.get('/:userId/exit', EmployeeExitController.getCurrent);
userRoutes.post('/:userId/exit', EmployeeExitController.initiate);
userRoutes.patch('/:userId/exit', EmployeeExitController.update);
userRoutes.post('/:userId/exit/confirm', EmployeeExitController.confirm);
userRoutes.post('/:userId/exit/immediate', EmployeeExitController.immediate);
userRoutes.post('/:userId/exit/cancel', EmployeeExitController.cancel);

userRoutes.patch('/:userId/location-tracking', TrackedLocationController.updateUserTracking);

userRoutes.get('/:userId', UserController.getEmployeeProfile);
userRoutes.get('/:userId/documents', UserController.getEmployeeDocuments);
userRoutes.get('/:userId/payrolls', UserController.getEmployeePayrolls);
userRoutes.get('/:userId/details', UserController.getEmployeeDetails);
userRoutes.get('/:userId/payroll/finance', UserController.getEmployeePayrollFinance);
userRoutes.patch('/:userId', UserController.update);
userRoutes.patch('/:userId/payroll/finance', UserController.updateEmployeePayrollFinance);
export { userRoutes };
