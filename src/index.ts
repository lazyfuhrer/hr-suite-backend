import './config/database';

import { app } from './app';
import { env } from './config/env';
import { logger } from './config/logger';
import { startAttendanceAutoClockOutScheduler } from './services/attendance-auto-clockout-scheduler.service';
import { startHalfDayNoPunchPenaltyScheduler } from './services/half-day-no-punch-penalty-scheduler.service';
import { startPayrollScheduler } from './services/payroll-scheduler.service';
import { startEmployeeExitScheduler } from './services/employee-exit-scheduler.service';
import { startNotificationAutomationScheduler } from './services/notifications/notification-automation.service';

const port = env.PORT;

const server = app.listen(port, () => {
  logger.info(`Server listening on port ${port}`);
  // Start in-process payroll scheduler (IST day 1 + startup grace; idempotent per user/month/year)
  startPayrollScheduler();
  // Start in-process attendance scheduler to auto close missed clock-outs.
  startAttendanceAutoClockOutScheduler();
  // Penalize approved half-day leave with no punch after IST midnight (yesterday).
  startHalfDayNoPunchPenaltyScheduler();
  // Start in-process notifications scheduler for shift/break automations.
  startNotificationAutomationScheduler();
  // Auto-complete notice-period exits after last_working_day (IST).
  startEmployeeExitScheduler();
});

let isShuttingDown = false;
const shutdown = (signal: string) => {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  logger.info(`Received ${signal}, shutting down...`);
  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(1);
  }, 5000);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
