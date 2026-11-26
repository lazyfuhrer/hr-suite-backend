import { Router } from 'express';

import { PayrollController, AdminPayrollController } from '../../controllers/tenant';
import { authenticateTenant, authorizeRole } from '../../middlewares';

const payrollRoutes = Router();

// Employee routes (all authenticated users can access their own payroll)
payrollRoutes.use(authenticateTenant);

// Employee payroll endpoints
payrollRoutes.get('/my/details', PayrollController.getMyPayrollDetails);
payrollRoutes.put('/my/details', PayrollController.updateMyPayrollDetails);
payrollRoutes.get('/my/salary-slip', PayrollController.downloadSalarySlip);
payrollRoutes.get('/my/salary-slip/:id', PayrollController.downloadSalarySlip);
payrollRoutes.get('/my/monthly-summary', PayrollController.getMonthlySummary);
payrollRoutes.get('/my/yearly-summary', PayrollController.getYearlySummary);
payrollRoutes.get('/my/tax-summary', PayrollController.getTaxSummary);
payrollRoutes.get('/my-pay', PayrollController.getMyPay);
payrollRoutes.get('/my-pay/history', PayrollController.getMyPayHistory);

// Payroll settings (org-level defaults) - Admin/HR only
payrollRoutes.get(
  '/settings',
  authorizeRole(['admin', 'hr']),
  AdminPayrollController.getOrgPayrollSettings,
);
payrollRoutes.put(
  '/settings',
  authorizeRole(['admin', 'hr']),
  AdminPayrollController.upsertOrgPayrollSettings,
);
payrollRoutes.get(
  '/settings/preview',
  authorizeRole(['admin', 'hr']),
  AdminPayrollController.previewOrgPayrollSettings,
);
payrollRoutes.get(
  '/settings/preview/user/:userId',
  authorizeRole(['admin', 'hr']),
  AdminPayrollController.previewOrgPayrollSettingsForUser,
);

// Admin/HR routes (require admin or hr role)
const adminPayrollRoutes = Router();

// Admin/HR/Manager routes (manager access limited in controller for these views)
adminPayrollRoutes.get(
  '/dashboard/summary',
  authorizeRole(['admin', 'hr', 'manager']),
  AdminPayrollController.getDashboardSummary,
);
adminPayrollRoutes.get(
  '/list',
  authorizeRole(['admin', 'hr', 'manager']),
  AdminPayrollController.getPayrollList,
);
adminPayrollRoutes.get(
  '/list/download-excel',
  authorizeRole(['admin', 'hr', 'manager']),
  AdminPayrollController.downloadPayrollExcel,
);

adminPayrollRoutes.use(authorizeRole(['admin', 'hr']));

// Salary components
adminPayrollRoutes.get('/components', AdminPayrollController.getSalaryComponents);
adminPayrollRoutes.post('/components', AdminPayrollController.createSalaryComponent);
adminPayrollRoutes.put('/components/:id', AdminPayrollController.updateSalaryComponent);
adminPayrollRoutes.delete('/components/:id', AdminPayrollController.deleteSalaryComponent);

// Salary structures
adminPayrollRoutes.get('/structures', AdminPayrollController.getSalaryStructures);
adminPayrollRoutes.post('/structures', AdminPayrollController.createSalaryStructure);
adminPayrollRoutes.put('/structures/:id', AdminPayrollController.updateSalaryStructure);

// Payroll records
adminPayrollRoutes.get('/records', AdminPayrollController.getPayrollRecords);
adminPayrollRoutes.post('/records', AdminPayrollController.createPayrollRecord);
adminPayrollRoutes.put('/records/:id', AdminPayrollController.updatePayrollRecord);
adminPayrollRoutes.post('/records/:id/process', AdminPayrollController.processPayrollRecord);
adminPayrollRoutes.get('/records/:id/payslip', AdminPayrollController.downloadPayslip);

// Payroll uploads
adminPayrollRoutes.post('/upload', AdminPayrollController.uploadPayrollFile);

// Payroll adjustment
adminPayrollRoutes.get('/adjust/:id', AdminPayrollController.getPayrollAdjustment);
adminPayrollRoutes.put('/adjust/:id', AdminPayrollController.updatePayrollAdjustment);

payrollRoutes.use('/admin', adminPayrollRoutes);

export { payrollRoutes };
