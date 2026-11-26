// IST timezone constant (UTC+5:30)
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // 5 hours 30 minutes in milliseconds

// Helper function to get current date/time in IST
export const getNowInIST = (): Date => {
  const now = new Date();
  // Convert UTC to IST by adding offset
  return new Date(now.getTime() + IST_OFFSET_MS);
};

// Helper function to format date as YYYY-MM-DD in IST timezone
export const formatDateLocal = (date: Date): string => {
  // Convert UTC date to IST for formatting
  const istDate = new Date(date.getTime() + IST_OFFSET_MS);
  const year = istDate.getUTCFullYear();
  const month = String(istDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(istDate.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// Helper function to get today's date in IST
export const getTodayDate = (): string => formatDateLocal(new Date());

// Helper function to normalize date to YYYY-MM-DD format for consistent matching
// Handles cases where database returns dates in different formats
/** Add calendar days to a YYYY-MM-DD string (timezone-neutral). */
export const addCalendarDays = (dateStr: string, deltaDays: number): string => {
  const parts = dateStr.split('-').map((p) => Number(p));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    return dateStr;
  }
  const [year, month, day] = parts;
  const utc = new Date(Date.UTC(year, month - 1, day + deltaDays));
  const y = utc.getUTCFullYear();
  const m = String(utc.getUTCMonth() + 1).padStart(2, '0');
  const d = String(utc.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

export const normalizeDate = (dateValue: string | Date | null | undefined): string => {
  if (!dateValue) return '';
  if (typeof dateValue === 'string') {
    // If already in YYYY-MM-DD format, return as is
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
      return dateValue;
    }
    // Try to parse and format
    const date = new Date(dateValue);
    if (!Number.isNaN(date.getTime())) {
      return formatDateLocal(date);
    }
  }
  if (dateValue instanceof Date) {
    return formatDateLocal(dateValue);
  }
  return String(dateValue);
};

// Helper function to format ISO timestamp to HH:MM in IST timezone
export const formatTime = (value?: string | null): string | null => {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  // Convert UTC to IST for display
  const istDate = new Date(date.getTime() + IST_OFFSET_MS);
  const hours = String(istDate.getUTCHours()).padStart(2, '0');
  const minutes = String(istDate.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
};

// Helper function to convert time string (HH:MM:SS or HH:MM) to ISO timestamp for a given date in IST
// The dateStr and timeStr are interpreted as IST, then converted to UTC ISO string
export const timeStringToISO = (
  dateStr: string,
  timeStr: string | null | undefined,
): string | null => {
  if (!timeStr || typeof timeStr !== 'string') {
    return null;
  }
  // Parse time string (supports both HH:MM:SS and HH:MM formats)
  const parts = timeStr.split(':');
  if (parts.length < 2) {
    return null;
  }
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1] || '0', 10);
  const seconds = parseInt(parts[2] || '0', 10);

  if (Number.isNaN(hours) || Number.isNaN(minutes) || Number.isNaN(seconds)) {
    return null;
  }

  // Create date string in IST format (interpret date and time as IST)
  // Format: YYYY-MM-DDTHH:mm:ss+05:30
  const istDateStr = `${dateStr}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}+05:30`;
  const date = new Date(istDateStr);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  // Return as UTC ISO string (database stores in UTC)
  return date.toISOString();
};

// Helper function to build ISO timestamp from date string (YYYY-MM-DD) and time string (HH:MM) in IST
export const buildIsoFromDateAndTimeLocal = (dateStr: string, timeHHmm: string): string => {
  // Parse the time string (HH:MM format)
  const [hours, minutes] = timeHHmm.split(':').map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    return '';
  }

  // Parse the date string (YYYY-MM-DD format)
  const [year, month, day] = dateStr.split('-').map(Number);
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) {
    return '';
  }

  // Create date string in IST format (interpret date and time as IST)
  // Format: YYYY-MM-DDTHH:mm:ss+05:30
  const istDateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00+05:30`;
  const date = new Date(istDateStr);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  // Return as UTC ISO string (database stores in UTC)
  return date.toISOString();
};

/** Last calendar day of month (1–12) for a given year. */
export const lastDayOfMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/** YYYY-MM-DD for the last day of the given calendar month. */
export const monthEndDateString = (year: number, month: number): string => {
  const day = lastDayOfMonth(year, month);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

/** YYYY-MM-DD for the first day of the given calendar month. */
export const monthStartDateString = (year: number, month: number): string =>
  `${year}-${String(month).padStart(2, '0')}-01`;

/** True when from_date is the 1st and to_date is the last day of the same calendar month. */
export const isFullCalendarMonthRange = (fromDate: string, toDate: string): boolean => {
  const fromParts = fromDate.split('-').map(Number);
  const toParts = toDate.split('-').map(Number);
  if (fromParts.length !== 3 || toParts.length !== 3) return false;
  const [fromYear, fromMonth, fromDay] = fromParts;
  const [toYear, toMonth, toDay] = toParts;
  if (fromDay !== 1) return false;
  if (fromYear !== toYear || fromMonth !== toMonth) return false;
  return toDay === lastDayOfMonth(fromYear, fromMonth);
};

/** True when dateStr falls on a calendar Sunday (UTC date parts). */
export const isCalendarSunday = (dateStr: string): boolean => {
  const parts = dateStr.split('-').map(Number);
  if (parts.length !== 3) return false;
  const [y, m, d] = parts;
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0;
};

/** Format ISO timestamp to IST dot-decimal time (e.g. 9.00, 18.30) — mirrors SQL FMHH24.MI. */
export const formatTimeDotDecimal = (value?: string | null): string | null => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const istDate = new Date(date.getTime() + IST_OFFSET_MS);
  const hours = istDate.getUTCHours();
  const minutes = String(istDate.getUTCMinutes()).padStart(2, '0');
  return `${hours}.${minutes}`;
};

// Helper function to parse time string (HH:MM:SS or HH:MM) to minutes since midnight
export const parseTimeToMinutes = (timeStr: string | null | undefined): number => {
  if (!timeStr || typeof timeStr !== 'string') {
    return 0;
  }
  const parts = timeStr.split(':');
  if (parts.length < 2) {
    return 0;
  }
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1] || '0', 10);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    return 0;
  }
  return hours * 60 + minutes;
};
