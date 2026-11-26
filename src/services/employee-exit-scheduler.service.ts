import { logger } from '../config/logger';
import { EmployeeExitService } from './employee-exit.service';

const oneDayMs = 24 * 60 * 60 * 1000;

/**
 * Daily in-process job:
 * 1. Starts notice for SCHEDULED exits when notice_start_date is reached (IST).
 * 2. Auto-completes ON_NOTICE exits when IST calendar date is after last_working_day.
 */
export function startEmployeeExitScheduler(): void {
  const runDaily = async () => {
    logger.info('Employee exit scheduler: processing due notice starts and auto-completions');
    try {
      const notice = await EmployeeExitService.processDueNoticeStarts();
      const complete = await EmployeeExitService.processDueAutoExits();
      logger.info({ notice, complete }, 'Employee exit scheduler daily run finished');
    } catch (error) {
      logger.error({ err: error }, 'Employee exit scheduler daily run failed');
    }
  };

  void runDaily();

  setInterval(() => {
    void runDaily();
  }, oneDayMs);
}
