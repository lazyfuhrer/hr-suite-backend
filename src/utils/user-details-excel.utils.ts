import ExcelJS from 'exceljs';

const HEADER_FILL = 'FFB4C6E7';
const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin' },
  left: { style: 'thin' },
  bottom: { style: 'thin' },
  right: { style: 'thin' },
};

export type UserDetailsExcelRow = {
  employee_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  official_email?: string | null;
  role?: string | null;
  status?: string | null;
  designation?: string | null;
  department_name?: string | null;
  date_of_joining?: Date | string | null;
  employment_type?: string | null;
  work_mode?: string | null;
  dob?: Date | string | null;
  gender?: string | null;
  marital_status?: string | null;
  blood_group?: string | null;
  nationality?: string | null;
  personal_email?: string | null;
  personal_phone?: string | null;
  emergency_contact_name?: string | null;
  emergency_contact_phone?: string | null;
  permanent_address?: string | null;
};

type ColumnDef = {
  header: string;
  width: number;
  value: (row: UserDetailsExcelRow) => string;
};

function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function dateOnly(value: Date | string | null | undefined): string {
  if (!value) return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    return value.toISOString().slice(0, 10);
  }
  const str = String(value);
  const parsed = new Date(str);
  if (Number.isNaN(parsed.getTime())) return str;
  return parsed.toISOString().slice(0, 10);
}

const COLUMNS: ColumnDef[] = [
  { header: 'Employee ID', width: 16, value: (r) => text(r.employee_id) },
  { header: 'First Name', width: 18, value: (r) => text(r.first_name) },
  { header: 'Last Name', width: 18, value: (r) => text(r.last_name) },
  { header: 'Official Email', width: 30, value: (r) => text(r.official_email) },
  { header: 'Role', width: 12, value: (r) => text(r.role) },
  { header: 'Status', width: 14, value: (r) => text(r.status) },
  { header: 'Designation', width: 22, value: (r) => text(r.designation) },
  { header: 'Department', width: 30, value: (r) => text(r.department_name) },
  { header: 'Date of Joining', width: 16, value: (r) => dateOnly(r.date_of_joining) },
  { header: 'Employment Type', width: 18, value: (r) => text(r.employment_type) },
  { header: 'Work Mode', width: 14, value: (r) => text(r.work_mode) },
  { header: 'Date of Birth', width: 14, value: (r) => dateOnly(r.dob) },
  { header: 'Gender', width: 12, value: (r) => text(r.gender) },
  { header: 'Marital Status', width: 16, value: (r) => text(r.marital_status) },
  { header: 'Blood Group', width: 14, value: (r) => text(r.blood_group) },
  { header: 'Nationality', width: 16, value: (r) => text(r.nationality) },
  { header: 'Personal Email', width: 30, value: (r) => text(r.personal_email) },
  { header: 'Personal Phone', width: 18, value: (r) => text(r.personal_phone) },
  { header: 'Emergency Contact Name', width: 24, value: (r) => text(r.emergency_contact_name) },
  { header: 'Emergency Contact Phone', width: 22, value: (r) => text(r.emergency_contact_phone) },
  { header: 'Permanent Address', width: 40, value: (r) => text(r.permanent_address) },
];

export async function generateUserDetailsExcelBuffer({
  rows,
}: {
  rows: UserDetailsExcelRow[];
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Employee Details');

  sheet.columns = COLUMNS.map((col) => ({ width: col.width }));

  const headerRow = sheet.getRow(1);
  COLUMNS.forEach((col, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = col.header;
    cell.font = { bold: true };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.border = THIN_BORDER;
  });
  headerRow.commit();

  rows.forEach((row, rowIndex) => {
    const sheetRow = sheet.getRow(rowIndex + 2);
    COLUMNS.forEach((col, colIndex) => {
      const cell = sheetRow.getCell(colIndex + 1);
      cell.value = col.value(row);
      cell.alignment = { vertical: 'top', wrapText: true };
      cell.border = THIN_BORDER;
    });
    sheetRow.commit();
  });

  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: COLUMNS.length },
  };

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

export function userDetailsExcelFileName(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `employee-details-${today}.xlsx`;
}
