import { logger } from '../config/logger';
import { generateMonthlyPayrollForAllEmployees } from './auto-payroll.service';
import { formatDateLocal, IST_OFFSET_MS } from '../utils/date.utils';

function istDayOfMonth(now: Date = new Date()): number {
  return Number(formatDateLocal(now).slice(8, 10));
}

/**
 * Milliseconds from `now` until the next IST calendar midnight
 * (same IST calendar notion as `formatDateLocal` / attendance).
 */
function msUntilNextISTMidnight(now: Date = new Date()): number {
  const t = now.getTime();
  const istNow = new Date(t + IST_OFFSET_MS);
  const y = istNow.getUTCFullYear();
  const m0 = istNow.getUTCMonth();
  const d = istNow.getUTCDate();
  const startTomorrowIst = Date.UTC(y, m0, d + 1, 0, 0, 0, 0) - IST_OFFSET_MS;
  return Math.max(0, startTomorrowIst - t);
}

async function runPayrollIfFirstOfMonthIst(): Promise<void> {
  const now = new Date();
  const day = istDayOfMonth(now);
  if (day !== 1) {
    logger.info(
      { ist_day: day },
      'Payroll scheduler tick: not IST calendar day 1, skipping auto generation',
    );
    return;
  }
  logger.info(
    { date: now.toISOString(), ist_date: formatDateLocal(now) },
    'Payroll scheduler: IST day 1 — generating previous month payroll if missing',
  );
  try {
    await generateMonthlyPayrollForAllEmployees({ referenceDate: now });
  } catch (error) {
    logger.error({ err: error }, 'Payroll scheduler run failed');
  }
}

/**
 * One-shot after deploy: if IST calendar is the 1st or 2nd, run the same idempotent
 * generation (covers a brief outage on the 1st without running mid-month).
 */
async function runPayrollStartupGraceIfDue(): Promise<void> {
  const now = new Date();
  const day = istDayOfMonth(now);
  if (day !== 1 && day !== 2) {
    return;
  }
  logger.info(
    { ist_day: day, ist_date: formatDateLocal(now) },
    'Payroll scheduler startup grace: running previous-month payroll if missing',
  );
  try {
    await generateMonthlyPayrollForAllEmployees({ referenceDate: now });
  } catch (error) {
    logger.error({ err: error }, 'Payroll scheduler startup grace run failed');
  }
}

/**
 * Runs automatic payroll creation only on IST calendar day 1 (previous month),
 * aligned to IST midnight ticks. Idempotent per (user, month, year).
 *
 * Startup: if IST is the 1st or 2nd, runs once to heal a missed 1st after deploy/outage.
 */
export function startPayrollScheduler(): void {
  const scheduleNextIstMidnightTick = (): void => {
    const delay = msUntilNextISTMidnight();
    setTimeout(() => {
      void (async () => {
        await runPayrollIfFirstOfMonthIst();
        scheduleNextIstMidnightTick();
      })();
    }, delay);
  };

  void (async () => {
    await runPayrollStartupGraceIfDue();
    scheduleNextIstMidnightTick();
  })();
}
