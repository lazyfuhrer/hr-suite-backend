import { Router } from 'express';

import { adminAuthRoutes } from './admin/auth.routes';
import { organizationRoutes } from './admin/organization.routes';
import { authRoutes } from './tenant/auth.routes';
import { departmentRoutes } from './tenant/department.routes';
import { userRoutes } from './tenant/user.routes';
import { officeLocationRoutes } from './tenant/office-location.routes';
import { geofenceRoutes } from './tenant/geofence.routes';
import { workShiftRoutes } from './tenant/work-shift.routes';
import { leaveRoutes } from './leave.routes';
import { wfhRoutes } from './wfh.routes';
import { reimbursementRoutes } from './reimbursement.routes';
import { onboardingRoutes } from './onboarding.routes';
import { reverseOnboardingRoutes } from './reverse-onboarding.routes';
import { attendanceRoutes } from './attendance.routes';
import { uploadRoutes } from './upload.routes';
import { payrollRoutes } from './tenant/payroll.routes';
import { dashboardRoutes } from './tenant/dashboard.routes';
import { tenantOrganizationRoutes } from './tenant/organization.routes';
import { holidayRoutes } from './tenant/holiday.routes';
import { AttendanceRequestController } from '../controllers/attendance-request.controller';
import { LeaveController } from '../controllers/leave.controller';
import { ReimbursementController } from '../controllers/reimbursement.controller';
import { WfhController } from '../controllers/wfh.controller';
import { UserController } from '../controllers/tenant';
import { authenticateTenant, authorizeRole } from '../middlewares';
import { organizationDocumentRoutes } from './tenant/organization-documents.routes';
import { helpdeskRoutes } from './helpdesk.routes';
import { ActivityController } from '../controllers/activity.controller';
import { AppraisalController } from '../controllers/tenant';
import { notificationsRoutes } from './notifications.routes';
import { locationsRoutes } from './locations.routes';

const adminRoutes = Router();
adminRoutes.use('/auth', adminAuthRoutes);
adminRoutes.use('/organizations', organizationRoutes);

const apiRoutes = Router();

apiRoutes.use('/admin', adminRoutes);
apiRoutes.use('/auth', authRoutes);
apiRoutes.use('/departments', departmentRoutes);
apiRoutes.use('/office-locations', officeLocationRoutes);
apiRoutes.use('/geofences', geofenceRoutes);
apiRoutes.use('/work-shifts', workShiftRoutes);
apiRoutes.use('/leaves', leaveRoutes);
apiRoutes.use('/wfh', wfhRoutes);
apiRoutes.use('/reimbursements', reimbursementRoutes);
apiRoutes.use('/onboarding', onboardingRoutes);
apiRoutes.use('/reverse-onboarding', reverseOnboardingRoutes);
apiRoutes.use('/attendance', attendanceRoutes);
apiRoutes.use('/uploads', uploadRoutes);
apiRoutes.use('/payroll', payrollRoutes);
apiRoutes.use('/dashboard', dashboardRoutes);
apiRoutes.use('/organization-documents', organizationDocumentRoutes);
apiRoutes.use('/organizations', tenantOrganizationRoutes);
apiRoutes.use('/holidays', holidayRoutes);
apiRoutes.use('/helpdesk', helpdeskRoutes);
apiRoutes.use('/notifications', notificationsRoutes);
apiRoutes.use('/locations', locationsRoutes);

// Unified requests feed (attendance + leaves, and potentially more in future)
apiRoutes.get(
  '/activity',
  authenticateTenant,
  authorizeRole(['admin', 'hr', 'manager']),
  ActivityController.listOrgActivities,
);

apiRoutes.get(
  '/requests/combined',
  authenticateTenant,
  authorizeRole(['admin', 'hr', 'manager']),
  AttendanceRequestController.listOrgCombined,
);

// Employee-scoped requests (attendance, leave, combined)
apiRoutes.get(
  '/users/:userId/attendance/requests',
  authenticateTenant,
  authorizeRole(['admin', 'hr', 'manager']),
  AttendanceRequestController.listForUser,
);
apiRoutes.get(
  '/users/attendance/requests/my',
  authenticateTenant,
  AttendanceRequestController.listForCurrentUserFromPath,
);

apiRoutes.get(
  '/users/:userId/leaves/requests',
  authenticateTenant,
  authorizeRole(['admin', 'hr', 'manager']),
  LeaveController.listOrgRequestsForUser,
);
apiRoutes.get(
  '/users/:userId/wfh/requests',
  authenticateTenant,
  authorizeRole(['admin', 'hr', 'manager']),
  WfhController.listOrgRequestsForUser,
);
apiRoutes.get(
  '/users/:userId/reimbursements/requests',
  authenticateTenant,
  authorizeRole(['admin', 'hr', 'manager']),
  ReimbursementController.listOrgRequestsForUser,
);
apiRoutes.post(
  '/users/:userId/reimbursements/mark-month-paid',
  authenticateTenant,
  authorizeRole(['admin', 'hr', 'manager']),
  ReimbursementController.markMonthPaidForUser,
);
apiRoutes.get(
  '/users/leaves/requests/my',
  authenticateTenant,
  LeaveController.listOrgRequestsForCurrentUserFromPath,
);
apiRoutes.get(
  '/users/reimbursements/requests/my',
  authenticateTenant,
  ReimbursementController.listOrgRequestsForCurrentUserFromPath,
);

apiRoutes.get(
  '/users/:userId/requests/combined',
  authenticateTenant,
  authorizeRole(['admin', 'hr', 'manager']),
  AttendanceRequestController.listOrgCombinedForUser,
);
apiRoutes.get(
  '/users/requests/combined/my',
  authenticateTenant,
  AttendanceRequestController.listCombinedForCurrentUserFromPath,
);

// Employee-scoped payroll records (admin/hr/manager)
apiRoutes.get(
  '/users/:userId/payrolls',
  authenticateTenant,
  authorizeRole(['admin', 'hr', 'manager']),
  UserController.getEmployeePayrolls,
);

// Employee-scoped salary/CTC appraisal endpoints
apiRoutes.post(
  '/users/:userId/appraisals',
  authenticateTenant,
  authorizeRole(['admin', 'hr', 'manager']),
  AppraisalController.createAppraisal,
);
apiRoutes.get(
  '/users/:userId/appraisals/history',
  authenticateTenant,
  authorizeRole(['admin', 'hr', 'manager']),
  AppraisalController.getAppraisalHistory,
);

apiRoutes.get(
  '/users/:userId/appraisals/salary-structure',
  authenticateTenant,
  authorizeRole(['admin', 'hr', 'manager']),
  AppraisalController.getCurrentSalaryStructure,
);

// Mount generic /users router after custom /users/* request routes above,
// so role-restricted middleware inside userRoutes does not intercept them.
apiRoutes.use('/users', userRoutes);

export { apiRoutes };
export {
  adminRoutes,
  adminAuthRoutes,
  organizationRoutes,
  authRoutes,
  departmentRoutes,
  userRoutes,
  officeLocationRoutes,
  geofenceRoutes,
  workShiftRoutes,
  onboardingRoutes,
  attendanceRoutes,
  uploadRoutes,
  payrollRoutes,
  dashboardRoutes,
  holidayRoutes,
  tenantOrganizationRoutes,
};
