import { Router } from 'express';

import { AttendanceController } from '../controllers/attendance.controller';
import { AttendanceRequestController } from '../controllers/attendance-request.controller';
import { authenticateTenant, authorizeRole } from '../middlewares';
import multer from 'multer';
import { env } from '../config/env';
import { attendanceAttachmentUploader } from '../utils/s3Uploader';
import { ATTENDANCE_BULK_IMPORT_MAX_BYTES } from '../validators/tenant/attendance-bulk-import.validator';

const attendanceRoutes = Router();

const faceClockUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.S3_UPLOAD_MAX_MB * 1024 * 1024,
    files: 1,
  },
});

const attendanceBulkImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: ATTENDANCE_BULK_IMPORT_MAX_BYTES,
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

attendanceRoutes.use(authenticateTenant);

attendanceRoutes.post('/clock-in', AttendanceController.clockIn);
attendanceRoutes.post('/clock-out', AttendanceController.clockOut);
attendanceRoutes.post('/break/start', AttendanceController.startBreak);
attendanceRoutes.post('/break/end', AttendanceController.endBreak);
attendanceRoutes.post(
  '/face-clock/location-verify',
  authorizeRole(['employee', 'manager', 'hr']),
  AttendanceController.faceClockLocationVerify,
);
attendanceRoutes.post(
  '/face-clock/verify-and-clock-in',
  authorizeRole(['employee', 'manager', 'hr']),
  faceClockUpload.single('image'),
  AttendanceController.faceVerifyAndClockIn,
);
attendanceRoutes.get('/dashboard-status', AttendanceController.getDashboardStatus);
attendanceRoutes.get('/calendar', AttendanceController.getCalendar);
attendanceRoutes.get('/weekly-summary', AttendanceController.getWeeklySummary);
attendanceRoutes.get('/monthly-performance', AttendanceController.getMonthlyPerformance);
attendanceRoutes.post(
  '/device/face-clock',
  authorizeRole(['admin', 'device']),
  faceClockUpload.single('image'),
  AttendanceController.faceClock,
);
attendanceRoutes.get(
  '/users/:userId/allowed-locations',
  authorizeRole(['admin', 'hr', 'manager']),
  AttendanceController.listUserAllowedLocations,
);
attendanceRoutes.get(
  '/users/:userId/clock-in-locations',
  authorizeRole(['admin', 'hr', 'manager']),
  AttendanceController.listUserClockInLocations,
);
attendanceRoutes.post(
  '/users/:userId/allowed-locations',
  authorizeRole(['admin', 'hr', 'manager']),
  AttendanceController.addUserAllowedLocation,
);
attendanceRoutes.patch(
  '/users/:userId/allowed-locations/:locationId',
  authorizeRole(['admin', 'hr', 'manager']),
  AttendanceController.updateUserAllowedLocationStatus,
);
attendanceRoutes.delete(
  '/users/:userId/allowed-locations/:locationId',
  authorizeRole(['admin', 'hr', 'manager']),
  AttendanceController.deleteUserAllowedLocation,
);
attendanceRoutes.get(
  '/admin/cards-summary',
  authorizeRole(['admin', 'hr', 'manager']),
  AttendanceController.getAdminCardsSummary,
);
attendanceRoutes.get(
  '/admin/dashboard',
  authorizeRole(['admin', 'hr', 'manager']),
  AttendanceController.getOrgDashboard,
);
attendanceRoutes.get(
  '/admin/users',
  authorizeRole(['admin', 'hr', 'manager']),
  AttendanceController.getOrgEmployeeAttendance,
);
attendanceRoutes.get(
  '/admin/users/download-excel',
  authorizeRole(['admin', 'hr', 'manager']),
  AttendanceController.downloadAttendanceExcel,
);
attendanceRoutes.get(
  '/admin/bulk-import/template',
  authorizeRole(['admin', 'hr']),
  AttendanceController.downloadAttendanceBulkImportTemplate,
);
attendanceRoutes.post(
  '/admin/bulk-import',
  authorizeRole(['admin', 'hr']),
  attendanceBulkImportUpload.single('file'),
  AttendanceController.bulkImportAttendance,
);
attendanceRoutes.get(
  '/manager/users',
  authorizeRole(['manager', 'hr']),
  AttendanceController.getManagerTeamAttendance,
);
attendanceRoutes.post('/requests', AttendanceRequestController.create);
attendanceRoutes.post(
  '/requests/regularize',
  attendanceAttachmentUploader,
  AttendanceRequestController.createRegularization,
);
attendanceRoutes.get(
  '/requests/regularize/details',
  AttendanceRequestController.getRegularizationDetails,
);
attendanceRoutes.get('/requests/my', AttendanceRequestController.listMy);
attendanceRoutes.post('/requests/:id/cancel', AttendanceRequestController.cancelRequest);
attendanceRoutes.get(
  '/requests',
  authorizeRole(['admin', 'hr', 'manager']),
  AttendanceRequestController.listPending,
);
attendanceRoutes.patch('/requests/:id/status', AttendanceRequestController.updateStatus);

export { attendanceRoutes };
