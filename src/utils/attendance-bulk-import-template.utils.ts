import ExcelJS from 'exceljs';

import {
  ATTENDANCE_BULK_IMPORT_CANONICAL_HEADERS,
  ATTENDANCE_BULK_IMPORT_MAX_ROWS,
} from '../validators/tenant/attendance-bulk-import.validator';
import { addCalendarDays, monthEndDateString, monthStartDateString } from './date.utils';

export type AttendanceBulkImportTemplateEmployee = {
  official_email: string;
  first_name?: string | null;
  last_name?: string | null;
};

export type AttendanceBulkImportSampleRow = {
  official_email: string;
  date: string;
  status: 'PRESENT' | 'ABSENT' | 'LATE';
  total_work_minutes: number;
  overtime_minutes: number;
};

function buildExampleRow(): Record<
  (typeof ATTENDANCE_BULK_IMPORT_CANONICAL_HEADERS)[number],
  string | number
> {
  return {
    official_email: 'anita@company.com',
    date: '2026-07-01',
    status: 'PRESENT',
    total_work_minutes: 480,
    overtime_minutes: 60,
  };
}

export const ATTENDANCE_BULK_IMPORT_SAMPLE_ROWS: AttendanceBulkImportSampleRow[] = [
  {
    official_email: 'anita@company.com',
    date: '2026-07-01',
    status: 'PRESENT',
    total_work_minutes: 480,
    overtime_minutes: 60,
  },
  {
    official_email: 'anita@company.com',
    date: '2026-07-02',
    status: 'LATE',
    total_work_minutes: 450,
    overtime_minutes: 30,
  },
  {
    official_email: 'anita@company.com',
    date: '2026-07-03',
    status: 'ABSENT',
    total_work_minutes: 0,
    overtime_minutes: 0,
  },
  {
    official_email: 'raj@company.com',
    date: '2026-07-01',
    status: 'PRESENT',
    total_work_minutes: 510,
    overtime_minutes: 0,
  },
  {
    official_email: 'raj@company.com',
    date: '2026-07-02',
    status: 'PRESENT',
    total_work_minutes: 480,
    overtime_minutes: 45,
  },
];

function listDatesInMonth(month: number, year: number): string[] {
  const start = monthStartDateString(year, month);
  const end = monthEndDateString(year, month);
  const dates: string[] = [];
  let current = start;
  while (current <= end) {
    dates.push(current);
    current = addCalendarDays(current, 1);
  }
  return dates;
}

function createAttendanceBulkImportWorkbook(): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'HR Management';
  workbook.created = new Date();
  return workbook;
}

function addAttendanceImportDataSheet(
  workbook: ExcelJS.Workbook,
  dataRows: Array<Array<string | number>>,
): ExcelJS.Worksheet {
  const dataSheet = workbook.addWorksheet('Attendance Import', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  dataSheet.addRow([...ATTENDANCE_BULK_IMPORT_CANONICAL_HEADERS]);
  for (const row of dataRows) {
    dataSheet.addRow(row);
  }

  const headerRow = dataSheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

  ATTENDANCE_BULK_IMPORT_CANONICAL_HEADERS.forEach((_, index) => {
    const column = dataSheet.getColumn(index + 1);
    column.width = index === 0 ? 32 : 22;
  });

  return dataSheet;
}

function addAttendanceBulkImportInstructionsSheet(workbook: ExcelJS.Workbook): void {
  const instructionsSheet = workbook.addWorksheet('Instructions');
  instructionsSheet.addRow(['Column', 'Required', 'Notes']);
  instructionsSheet.addRow([
    'official_email',
    'Yes',
    'Employee work email in this organization (case-insensitive match)',
  ]);
  instructionsSheet.addRow(['date', 'Yes', 'Format: YYYY-MM-DD']);
  instructionsSheet.addRow(['status', 'Yes', 'PRESENT | ABSENT | LATE']);
  instructionsSheet.addRow([
    'total_work_minutes',
    'Yes for PRESENT/LATE; 0 for ABSENT',
    'Non-negative integer',
  ]);
  instructionsSheet.addRow([
    'overtime_minutes',
    'No',
    'Non-negative integer (default 0). Ignored for ABSENT.',
  ]);
  instructionsSheet.addRow([
    'month/year query',
    'Optional',
    'When downloading template with ?month=&year=, rows are pre-filled for all active employees for each day of that month.',
  ]);
  instructionsSheet.addRow([
    'shift default',
    'N/A',
    'If employee has no shift configured, synthetic clock times use 09:00–18:00.',
  ]);
  instructionsSheet.addRow([
    'max_rows',
    'N/A',
    `${ATTENDANCE_BULK_IMPORT_MAX_ROWS} rows per import`,
  ]);
  instructionsSheet.getRow(1).font = { bold: true };
  instructionsSheet.getColumn(1).width = 24;
  instructionsSheet.getColumn(2).width = 14;
  instructionsSheet.getColumn(3).width = 80;
}

async function workbookToBuffer(workbook: ExcelJS.Workbook): Promise<Buffer> {
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

export async function buildAttendanceBulkImportTemplateBuffer(params: {
  employees: AttendanceBulkImportTemplateEmployee[];
  month?: number;
  year?: number;
}): Promise<Buffer> {
  const workbook = createAttendanceBulkImportWorkbook();

  const exampleRow = buildExampleRow();
  const hasMonthYear =
    params.month !== undefined && params.year !== undefined && params.employees.length > 0;

  const dataRows: Array<Array<string | number>> = [];

  if (hasMonthYear) {
    const dates = listDatesInMonth(params.month!, params.year!);
    for (const employee of params.employees) {
      for (const date of dates) {
        dataRows.push([employee.official_email, date, '', '', '']);
      }
    }
  } else {
    dataRows.push(ATTENDANCE_BULK_IMPORT_CANONICAL_HEADERS.map((header) => exampleRow[header]));
  }

  addAttendanceImportDataSheet(workbook, dataRows);
  addAttendanceBulkImportInstructionsSheet(workbook);

  return workbookToBuffer(workbook);
}

export async function buildAttendanceBulkImportSampleBuffer(): Promise<Buffer> {
  const workbook = createAttendanceBulkImportWorkbook();

  const dataRows = ATTENDANCE_BULK_IMPORT_SAMPLE_ROWS.map((row) => [
    row.official_email,
    row.date,
    row.status,
    row.total_work_minutes,
    row.overtime_minutes,
  ]);

  addAttendanceImportDataSheet(workbook, dataRows);
  addAttendanceBulkImportInstructionsSheet(workbook);

  return workbookToBuffer(workbook);
}

export const ATTENDANCE_BULK_IMPORT_TEMPLATE_FILENAME = 'attendance_bulk_import_template.xlsx';
export const ATTENDANCE_BULK_IMPORT_SAMPLE_FILENAME = 'attendance_bulk_import_sample.xlsx';

export function attendanceBulkImportTemplateFilename(month?: number, year?: number): string {
  if (month !== undefined && year !== undefined) {
    return `attendance_bulk_import_${year}_${String(month).padStart(2, '0')}.xlsx`;
  }
  return ATTENDANCE_BULK_IMPORT_TEMPLATE_FILENAME;
}
