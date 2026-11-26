import * as XLSX from 'xlsx';

import { AttendanceBreak } from '../models/AttendanceBreak';
import { AttendanceLog } from '../models/AttendanceLog';
import { User } from '../models/User';
import { ATTENDANCE_ACTIVE_EMPLOYEE_STATUSES } from '../constants/user-status';
import { resolveShift } from './attendance-shift.service';
import {
  buildAttendanceLogPatchFromImport,
  DEFAULT_IMPORT_SHIFT_START,
} from '../utils/attendance-import.utils';
import { getOrgLateGracePeriodMins } from '../utils/late-grace.utils';
import { monthEndDateString, monthStartDateString, normalizeDate } from '../utils/date.utils';
import {
  ATTENDANCE_BULK_IMPORT_CANONICAL_HEADERS,
  ATTENDANCE_BULK_IMPORT_MAX_ROWS,
  attendanceBulkImportRowSchema,
  normalizeAttendanceBulkImportHeader,
  type AttendanceBulkImportRow,
} from '../validators/tenant/attendance-bulk-import.validator';

export type AttendanceBulkImportRowResultStatus = 'valid' | 'created' | 'updated' | 'failed';

export interface AttendanceBulkImportRowResult {
  row: number;
  official_email?: string;
  date?: string;
  status: AttendanceBulkImportRowResultStatus;
  attendance_log_id?: string;
  error?: string;
}

export interface AttendanceBulkImportSummary {
  total_rows: number;
  valid: number;
  created: number;
  updated: number;
  failed: number;
  skipped: number;
}

export interface AttendanceBulkImportOutcome {
  summary: AttendanceBulkImportSummary;
  results: AttendanceBulkImportRowResult[];
}

export class AttendanceBulkImportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttendanceBulkImportParseError';
  }
}

interface ParsedRawRow {
  rowNumber: number;
  raw: Record<string, unknown>;
}

function isRowEmpty(raw: Record<string, unknown>): boolean {
  return Object.values(raw).every(
    (value) => value === undefined || value === null || String(value).trim() === '',
  );
}

function formatZodErrors(error: {
  flatten: () => { fieldErrors: Record<string, string[]> };
}): string {
  const fieldErrors = error.flatten().fieldErrors;
  const parts = Object.entries(fieldErrors).flatMap(([field, messages]) =>
    (messages ?? []).map((message) => `${field}: ${message}`),
  );
  return parts.join('; ') || 'Invalid row data';
}

export function parseAttendanceBulkImportWorkbook(buffer: Buffer): ParsedRawRow[] {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new AttendanceBulkImportParseError('Workbook has no sheets');
  }

  const worksheet = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
    header: 1,
    defval: '',
    raw: false,
  });

  if (matrix.length === 0) {
    throw new AttendanceBulkImportParseError('Excel sheet is empty');
  }

  const headerRow = matrix[0] ?? [];
  const dataMatrix = matrix.slice(1);

  const headerMap = new Map<string, (typeof ATTENDANCE_BULK_IMPORT_CANONICAL_HEADERS)[number]>();
  for (const headerCell of headerRow) {
    const canonical = normalizeAttendanceBulkImportHeader(headerCell);
    if (canonical) {
      headerMap.set(String(headerCell).trim(), canonical);
    }
  }

  const mappedCanonical = new Set(headerMap.values());
  const requiredHeaders = [
    'official_email',
    'date',
    'status',
    'total_work_minutes',
  ] as const satisfies ReadonlyArray<(typeof ATTENDANCE_BULK_IMPORT_CANONICAL_HEADERS)[number]>;
  const missingRequiredHeaders = requiredHeaders.filter((header) => !mappedCanonical.has(header));

  if (missingRequiredHeaders.length > 0) {
    throw new AttendanceBulkImportParseError(
      `Missing required column headers: ${missingRequiredHeaders.join(', ')}`,
    );
  }

  const canonicalToSourceKey = new Map<
    (typeof ATTENDANCE_BULK_IMPORT_CANONICAL_HEADERS)[number],
    number
  >();
  headerRow.forEach((headerCell, index) => {
    const canonical = normalizeAttendanceBulkImportHeader(headerCell);
    if (canonical && !canonicalToSourceKey.has(canonical)) {
      canonicalToSourceKey.set(canonical, index);
    }
  });

  const parsedRows: ParsedRawRow[] = [];

  dataMatrix.forEach((rowValues, index) => {
    const normalized: Record<string, unknown> = {};
    for (const header of ATTENDANCE_BULK_IMPORT_CANONICAL_HEADERS) {
      const columnIndex = canonicalToSourceKey.get(header);
      if (columnIndex === undefined) continue;
      const value = rowValues[columnIndex];
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        normalized[header] = value;
      }
    }

    if (isRowEmpty(normalized)) {
      return;
    }

    parsedRows.push({
      rowNumber: index + 2,
      raw: normalized,
    });
  });

  if (parsedRows.length === 0) {
    throw new AttendanceBulkImportParseError('No data rows found in Excel sheet');
  }

  if (parsedRows.length > ATTENDANCE_BULK_IMPORT_MAX_ROWS) {
    throw new AttendanceBulkImportParseError(
      `Too many data rows (${parsedRows.length}). Maximum allowed is ${ATTENDANCE_BULK_IMPORT_MAX_ROWS}.`,
    );
  }

  return parsedRows;
}

function normalizeRow(raw: ParsedRawRow): Record<string, unknown> {
  return {
    rowNumber: raw.rowNumber,
    ...raw.raw,
  };
}

function eligibleUserQuery(orgId: string) {
  return User.query()
    .where('org_id', orgId)
    .whereNull('deleted_at')
    .whereIn('status', ATTENDANCE_ACTIVE_EMPLOYEE_STATUSES as readonly string[])
    .whereNot('role', 'device');
}

async function resolveUserByOfficialEmail(
  orgId: string,
  officialEmail: string,
): Promise<User | undefined> {
  let user = await eligibleUserQuery(orgId).where('official_email', officialEmail).first();
  if (!user) {
    user = await eligibleUserQuery(orgId)
      .whereRaw('LOWER(TRIM(official_email)) = ?', [officialEmail])
      .first();
  }
  return user;
}

function isDateWithinMonthYear(date: string, month: number, year: number): boolean {
  const start = monthStartDateString(year, month);
  const end = monthEndDateString(year, month);
  return date >= start && date <= end;
}

function isDateBeforeJoining(date: string, user: User): boolean {
  const joining = normalizeDate(user.date_of_joining);
  if (!joining) return false;
  return date < joining;
}

async function validateSingleRow(params: {
  parsed: ParsedRawRow;
  orgId: string;
  month?: number;
  year?: number;
  seenKeys: Map<string, number>;
}): Promise<{
  result: AttendanceBulkImportRowResult;
  row?: AttendanceBulkImportRow;
  user?: User;
  wouldUpdate?: boolean;
}> {
  const normalized = normalizeRow(params.parsed);
  const zodResult = attendanceBulkImportRowSchema.safeParse(normalized);

  const baseEmail = String(normalized.official_email ?? '');
  const baseDate = String(normalized.date ?? '');

  if (!zodResult.success) {
    return {
      result: {
        row: params.parsed.rowNumber,
        official_email: baseEmail || undefined,
        date: baseDate || undefined,
        status: 'failed',
        error: formatZodErrors(zodResult.error),
      },
    };
  }

  const row = zodResult.data;
  const duplicateKey = `${row.official_email}|${row.date}`;

  if (params.seenKeys.has(duplicateKey)) {
    return {
      result: {
        row: row.rowNumber,
        official_email: row.official_email,
        date: row.date,
        status: 'failed',
        error: `Duplicate official_email and date in file (also on row ${params.seenKeys.get(duplicateKey)})`,
      },
    };
  }
  params.seenKeys.set(duplicateKey, row.rowNumber);

  if (params.month !== undefined && params.year !== undefined) {
    if (!isDateWithinMonthYear(row.date, params.month, params.year)) {
      return {
        result: {
          row: row.rowNumber,
          official_email: row.official_email,
          date: row.date,
          status: 'failed',
          error: `date must fall within ${params.year}-${String(params.month).padStart(2, '0')}`,
        },
      };
    }
  }

  const user = await resolveUserByOfficialEmail(params.orgId, row.official_email);
  if (!user) {
    return {
      result: {
        row: row.rowNumber,
        official_email: row.official_email,
        date: row.date,
        status: 'failed',
        error: 'No active user found with this official_email',
      },
    };
  }

  if (isDateBeforeJoining(row.date, user)) {
    return {
      result: {
        row: row.rowNumber,
        official_email: row.official_email,
        date: row.date,
        status: 'failed',
        error: 'date is before employee date_of_joining',
      },
    };
  }

  const existing = await AttendanceLog.query().findOne({
    org_id: params.orgId,
    user_id: user.id,
    date: row.date,
  });

  return {
    result: {
      row: row.rowNumber,
      official_email: row.official_email,
      date: row.date,
      status: 'valid',
      attendance_log_id: existing?.id,
    },
    row,
    user,
    wouldUpdate: Boolean(existing),
  };
}

export async function validateAttendanceBulkImportRows(params: {
  parsedRows: ParsedRawRow[];
  orgId: string;
  month?: number;
  year?: number;
}): Promise<AttendanceBulkImportOutcome> {
  const results: AttendanceBulkImportRowResult[] = [];
  const seenKeys = new Map<string, number>();

  for (const parsed of params.parsedRows) {
    const { result } = await validateSingleRow({
      parsed,
      orgId: params.orgId,
      month: params.month,
      year: params.year,
      seenKeys,
    });
    results.push(result);
  }

  return buildOutcome(results, true);
}

async function importSingleRow(params: {
  row: AttendanceBulkImportRow;
  user: User;
  orgId: string;
  actorUserId: string;
  lateGracePeriodMins: number;
}): Promise<AttendanceBulkImportRowResult> {
  const baseResult: AttendanceBulkImportRowResult = {
    row: params.row.rowNumber,
    official_email: params.row.official_email,
    date: params.row.date,
    status: 'failed',
  };

  try {
    const shift = await resolveShift(params.orgId, params.user.id);
    const shiftStartTime = shift?.start_time ?? DEFAULT_IMPORT_SHIFT_START;
    const overtimeMinutes = params.row.overtime_minutes ?? 0;
    const importedAt = new Date().toISOString();

    const patch = buildAttendanceLogPatchFromImport({
      orgId: params.orgId,
      userId: params.user.id,
      date: params.row.date,
      importStatus: params.row.status,
      totalWorkMinutes: params.row.total_work_minutes ?? 0,
      overtimeMinutes,
      shiftStartTime,
      lateGracePeriodMins: params.lateGracePeriodMins,
      importedByUserId: params.actorUserId,
      importedAt,
    });

    const outcome = await AttendanceLog.transaction(async (trx) => {
      const existing = await AttendanceLog.query(trx).findOne({
        org_id: params.orgId,
        user_id: params.user.id,
        date: params.row.date,
      });

      if (existing) {
        await AttendanceBreak.query(trx).where('attendance_log_id', existing.id).delete();
        const updated = await AttendanceLog.query(trx).patchAndFetchById(existing.id, patch);
        return { log: updated, action: 'updated' as const };
      }

      const created = await AttendanceLog.query(trx).insert(patch);
      return { log: created, action: 'created' as const };
    });

    return {
      ...baseResult,
      status: outcome.action,
      attendance_log_id: outcome.log.id,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to import attendance row';
    return { ...baseResult, error: message };
  }
}

export async function importAttendanceBulkRows(params: {
  parsedRows: ParsedRawRow[];
  orgId: string;
  actorUserId: string;
  month?: number;
  year?: number;
}): Promise<AttendanceBulkImportOutcome> {
  const results: AttendanceBulkImportRowResult[] = [];
  const seenKeys = new Map<string, number>();

  const lateGracePeriodMins = await getOrgLateGracePeriodMins(params.orgId);

  for (const parsed of params.parsedRows) {
    const validation = await validateSingleRow({
      parsed,
      orgId: params.orgId,
      month: params.month,
      year: params.year,
      seenKeys,
    });

    if (validation.result.status === 'failed' || !validation.row || !validation.user) {
      results.push(
        validation.result.status === 'failed'
          ? validation.result
          : {
              row: parsed.rowNumber,
              status: 'failed',
              error: 'Row failed validation',
            },
      );
      continue;
    }

    const importResult = await importSingleRow({
      row: validation.row,
      user: validation.user,
      orgId: params.orgId,
      actorUserId: params.actorUserId,
      lateGracePeriodMins,
    });
    results.push(importResult);
  }

  return buildOutcome(results, false);
}

function buildOutcome(
  results: AttendanceBulkImportRowResult[],
  dryRun: boolean,
): AttendanceBulkImportOutcome {
  const failed = results.filter((r) => r.status === 'failed').length;

  let created = 0;
  let updated = 0;

  if (dryRun) {
    for (const result of results) {
      if (result.status !== 'valid') continue;
      if (result.attendance_log_id) {
        updated += 1;
      } else {
        created += 1;
      }
    }
  } else {
    created = results.filter((r) => r.status === 'created').length;
    updated = results.filter((r) => r.status === 'updated').length;
  }

  return {
    summary: {
      total_rows: results.length,
      valid: results.length - failed,
      created,
      updated,
      failed,
      skipped: 0,
    },
    results,
  };
}

export function parseAndPrepareAttendanceBulkImport(buffer: Buffer): ParsedRawRow[] {
  return parseAttendanceBulkImportWorkbook(buffer);
}
